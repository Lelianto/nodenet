/**
 * `nodenet report` — deterministic, repository-local highlights report.
 *
 * Phase 8 follow-up / Round 1 quick win: an auto-generated markdown report
 * that answers "what is interesting in this graph?" without any LLM:
 *   - god nodes (highest-degree symbols),
 *   - surprising connections (cross-community symbol links),
 *   - community summary (size + representative nodes),
 *   - governance overview (contexts, authority, ownership coverage),
 *   - suggested questions the graph is positioned to answer.
 *
 * Everything is derived from persisted graph state; output is identical for
 * identical input (spec: deterministic, local-first).
 */

import type { Graph } from "../graph/graph.js";
import { nodeLabel, type GraphNode, type NodeKind } from "../graph/nodes.js";
import type { Relation } from "../graph/edges.js";import { CODE_RELATIONS } from "../graph/edges.js";
import type { SafeRelativePath } from "../security/filesystem.js";
import type { ContextRecord } from "../context/schema.js";
import type { OwnershipIndex } from "../ownership/resolver.js";
import type { LoadedConfig } from "../config/config.js";
import { computeHealth, type HealthReport } from "../health/health.js";
import { detectCommunities, type CommunityId } from "../visualization/communities.js";
import { matchGlob } from "../utils/glob.js";
import { NODENET_VERSION } from "../version.js";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

/** Highest-degree symbol nodes, ranked. */
export interface ReportGodNode {
  name: string;
  kind: NodeKind;
  path: string;
  line: number;
  /** Incident edges excluding structural `contains` edges. */
  degree: number;
  /** Distinct files that reference, call or use this symbol. */
  consumers: number;
}

/** A code-level connection spanning two different communities. */
export interface ReportConnection {
  from: string;
  to: string;
  relation: Relation;
  fromCommunity: CommunityId;
  toCommunity: CommunityId;
  provenance: string;
}

export interface ReportCommunity {
  id: CommunityId;
  size: number;
  /** Representative node labels (highest-degree members). */
  topNodes: string[];
}

export interface ReportGovernance {
  contexts: {
    total: number;
    byStatus: Record<string, number>;
    byAuthority: Record<string, number>;
    conflicts: number;
    orphan: number;
  };
  ownershipCoverage: number;
  authorityCoverage: number;
  warnings: string[];
}

export interface ReportSuggestedQuestion {
  question: string;
  answer: string;
}

export interface GraphReport {
  timestamp: string;
  provenance: {
    nodenetVersion: string;
    nodeVersion: string;
    configHash: string;
    repositoryCommit?: string;
    repositoryDirty?: boolean;
  };
  summary: {
    nodes: number;
    edges: number;
    files: number;
    codeSymbols: number;
    communities: number;
  };
  godNodes: ReportGodNode[];
  surprisingConnections: ReportConnection[];
  communities: ReportCommunity[];
  governance: ReportGovernance;
  suggestedQuestions: ReportSuggestedQuestion[];
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const SYMBOL_KINDS: readonly NodeKind[] = [
  "function",
  "method",
  "class",
  "interface",
  "typeAlias",
  "enum",
  "variable",
  "reactComponent",
  "reactHook",
];

function isSymbolKind(kind: NodeKind): boolean {
  return (SYMBOL_KINDS as readonly NodeKind[]).includes(kind);
}

function nodePath(node: GraphNode): string {
  const p = (node as { path?: SafeRelativePath }).path;
  return typeof p === "string" ? p : "";
}

function nodeLine(node: GraphNode): number {
  const line = (node as { line?: number }).line;
  return typeof line === "number" ? line : 0;
}

function top<T>(items: T[], key: (item: T) => number, limit: number): T[] {
  return [...items].sort((a, b) => key(b) - key(a)).slice(0, limit);
}

/** Symbols ranked by incident coupling (excluding `contains` edges). */
function computeGodNodes(graph: Graph, limit: number): ReportGodNode[] {
  const consumersByNode = new Map<string, Set<string>>();
  const degreeByNode = new Map<string, number>();

  for (const edge of graph.edges()) {
    if (edge.relation === "contains") continue;
    const from = graph.getNode(edge.from);
    const to = graph.getNode(edge.to);
    if (!from || !to) continue;

    const symbol = isSymbolKind(from.kind) ? from : isSymbolKind(to.kind) ? to : null;
    if (!symbol) continue;
    degreeByNode.set(symbol.id, (degreeByNode.get(symbol.id) ?? 0) + 1);

    // consumers: files that reference, call or use the symbol. Both file
    // and symbol nodes carry the file path, so the source file is the
    // source node's own path.
    if (edge.relation === "references" || edge.relation === "calls" || edge.relation === "uses") {
      const sourceFile = nodePath(from);
      if (sourceFile) {
        const set = consumersByNode.get(symbol.id) ?? new Set<string>();
        set.add(sourceFile);
        consumersByNode.set(symbol.id, set);
      }
    }
  }

  const symbols = graph.findNodes((n) => isSymbolKind(n.kind));
  const godNodes: ReportGodNode[] = symbols.map((node) => ({
    name: node.name,
    kind: node.kind,
    path: nodePath(node),
    line: nodeLine(node),
    degree: degreeByNode.get(node.id) ?? 0,
    consumers: consumersByNode.get(node.id)?.size ?? 0,
  }));
  return top(godNodes, (g) => g.degree, limit).filter((g) => g.degree > 0);
}

/** Code-level edges whose two endpoints (symbols or files) live in different communities. */
function computeSurprisingConnections(
  graph: Graph,
  communities: Map<string, CommunityId>,
  limit: number,
): ReportConnection[] {
  const seen = new Set<string>();
  const connections: ReportConnection[] = [];

  for (const edge of graph.edges()) {
    if (!(CODE_RELATIONS as readonly Relation[]).includes(edge.relation)) continue;
    const from = graph.getNode(edge.from);
    const to = graph.getNode(edge.to);
    if (!from || !to) continue;
    if (!isSymbolKind(from.kind) && from.kind !== "file") continue;
    if (!isSymbolKind(to.kind) && to.kind !== "file") continue;

    const fromCommunity = communities.get(from.id);
    const toCommunity = communities.get(to.id);
    if (fromCommunity === undefined || toCommunity === undefined) continue;
    if (fromCommunity === toCommunity) continue;

    const key = [from.id, to.id].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);

    connections.push({
      from: nodeLabel(from),
      to: nodeLabel(to),
      relation: edge.relation,
      fromCommunity,
      toCommunity,
      provenance: edge.provenance.source,
    });
  }
  return top(connections, (c) => Math.abs(c.fromCommunity - c.toCommunity), limit);
}

function computeCommunities(
  graph: Graph,
  communities: Map<string, CommunityId>,
): ReportCommunity[] {
  const grouped = new Map<CommunityId, GraphNode[]>();
  for (const node of graph.nodes()) {
    const cid = communities.get(node.id);
    if (cid === undefined) continue;
    const list = grouped.get(cid) ?? [];
    list.push(node);
    grouped.set(cid, list);
  }

  const degreeByNode = new Map<string, number>();
  for (const edge of graph.edges()) {
    if (edge.relation === "contains") continue;
    degreeByNode.set(edge.from, (degreeByNode.get(edge.from) ?? 0) + 1);
    degreeByNode.set(edge.to, (degreeByNode.get(edge.to) ?? 0) + 1);
  }

  const communitiesList: ReportCommunity[] = [];
  for (const [cid, nodes] of grouped) {
    const symbols = nodes.filter((n) => isSymbolKind(n.kind) || n.kind === "file");
    const representative = top(
      symbols,
      (n) => degreeByNode.get(n.id) ?? 0,
      3,
    );
    communitiesList.push({
      id: cid,
      size: nodes.length,
      topNodes: representative.map((n) => nodeLabel(n)),
    });
  }
  return communitiesList.sort((a, b) => b.size - a.size);
}

function computeGovernance(
  health: HealthReport,
  contexts: ContextRecord[],
): ReportGovernance {
  const byAuthority: Record<string, number> = {};
  for (const ctx of contexts) {
    byAuthority[ctx.authority] = (byAuthority[ctx.authority] ?? 0) + 1;
  }
  return {
    contexts: {
      total: health.contexts.total,
      byStatus: health.contexts.byStatus,
      byAuthority,
      conflicts: health.contexts.conflicts,
      orphan: health.contexts.orphan,
    },
    ownershipCoverage: health.ownershipCoverage,
    authorityCoverage: health.authorityCoverage,
    warnings: health.warnings,
  };
}

function computeSuggestedQuestions(
  godNodes: ReportGodNode[],
  connections: ReportConnection[],
  communitiesList: ReportCommunity[],
  contexts: ContextRecord[],
  ownership: OwnershipIndex,
  governance: ReportGovernance,
): ReportSuggestedQuestion[] {
  const questions: ReportSuggestedQuestion[] = [];

  const topGod = godNodes[0];
  if (topGod) {
    const safe = topGod.path as SafeRelativePath;
    const owner = safe ? ownership.resolveOwner(safe) : null;
    questions.push({
      question: `Who owns the most-coupled symbol (${topGod.name})?`,
      answer: owner
        ? `${topGod.path} → ${owner.owner} (source: ${owner.source}, ${owner.confidence.toLowerCase()})`
        : `No declared owner for ${topGod.path}. Run \`nodenet owner ${topGod.path}\` or declare ownership.`,
    });
  }

  if (topGod) {
    const governing = contexts.filter((ctx) =>
      ctx.appliesTo.some((pattern) => matchGlob(pattern, topGod.path)),
    );
    questions.push({
      question: `Which living contexts govern ${topGod.path}?`,
      answer:
        governing.length > 0
          ? governing.map((ctx) => `${ctx.id} [${ctx.status}] ${ctx.authority}`).join(", ")
          : `None. Run \`nodenet governed-by ${topGod.path}\` for details.`,
    });
  }

  const firstConnection = connections[0];
  if (firstConnection) {
    questions.push({
      question: `Why does ${firstConnection.from} connect to ${firstConnection.to} across communities ${firstConnection.fromCommunity} → ${firstConnection.toCommunity}?`,
      answer: `Via a \`${firstConnection.relation}\` edge (source: ${firstConnection.provenance}). Trace it with \`nodenet trace ${firstConnection.from.split(" @ ")[0]?.split(" ")[0]} ${firstConnection.to.split(" @ ")[0]?.split(" ")[0]}\`.`,
    });
  }

  const largestCommunity = communitiesList[0];
  if (largestCommunity) {
    questions.push({
      question: `What lives in the largest community (${largestCommunity.size} nodes)?`,
      answer: `Top members: ${largestCommunity.topNodes.join(", ")}. Explore with \`nodenet graph\`.`,
    });
  }

  if (governance.contexts.total > 0) {
    questions.push({
      question: "How healthy is the living context layer?",
      answer: `${governance.contexts.total} contexts, ${governance.contexts.conflicts} conflict(s), ${governance.contexts.orphan} orphaned. Ownership coverage ${governance.ownershipCoverage}%, authority coverage ${governance.authorityCoverage}%. Full report: \`nodenet health\`.`,
    });
  }

  const biggestBoundary = connections.find((c) => c.relation === "calls" || c.relation === "uses");
  if (biggestBoundary && godNodes.length > 1) {    questions.push({
      question: "What would break if the most-coupled symbol changed?",
      answer: `Run \`nodenet impact --base main\` to see affected files, ownership boundaries, and required reviewers for the current change.`,
    });
  }

  if (questions.length === 0) {
    questions.push({
      question: "Nothing surprising found — what can I do next?",
      answer: "Run `nodenet graph` to explore, `nodenet health` for context health, and `nodenet impact --base main` for the current change.",
    });
  }
  return questions;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildReport(
  graph: Graph,
  contexts: ContextRecord[],
  ownership: OwnershipIndex,
  config: LoadedConfig,
  now: Date = new Date(),
  limits: { godNodes?: number; connections?: number } = {},
): GraphReport {
  const communities = detectCommunities(graph);
  const health = computeHealth(graph, contexts, ownership, config, now);
  const godNodes = computeGodNodes(graph, limits.godNodes ?? 10);
  const connections = computeSurprisingConnections(graph, communities, limits.connections ?? 10);
  const communitiesList = computeCommunities(graph, communities);
  const governance = computeGovernance(health, contexts);
  const suggestedQuestions = computeSuggestedQuestions(
    godNodes,
    connections,
    communitiesList,
    contexts,
    ownership,
    governance,
  );

  let codeSymbols = 0;
  let files = 0;
  for (const node of graph.nodes()) {
    if (node.kind === "file") files++;
    else if (isSymbolKind(node.kind)) codeSymbols++;
  }

  const git = repositoryProvenance(graph.metadata.root);
  return {
    timestamp: now.toISOString(),
    provenance: {
      nodenetVersion: NODENET_VERSION,
      nodeVersion: process.version,
      configHash: crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex"),
      ...git,
    },
    summary: {
      nodes: graph.size,
      edges: graph.edgeCount,
      files,
      codeSymbols,
      communities: communitiesList.length,
    },
    godNodes,
    surprisingConnections: connections,
    communities: communitiesList,
    governance,
    suggestedQuestions,
  };
}

function repositoryProvenance(root: string): { repositoryCommit?: string; repositoryDirty?: boolean } {
  const commit = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3_000 });
  if (commit.status !== 0) return {};
  const status = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8", timeout: 3_000 });
  return {
    repositoryCommit: commit.stdout.trim(),
    ...(status.status === 0 ? { repositoryDirty: status.stdout.trim().length > 0 } : {}),
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

export function renderReportMarkdown(report: GraphReport): string {
  const lines: string[] = [];
  lines.push(`# NodeNet Report`);
  lines.push(`\n_Generated ${report.timestamp} — deterministic, derived from the persisted graph._`);
  lines.push(`\n- **NodeNet:** ${report.provenance.nodenetVersion}`);
  lines.push(`- **Node.js:** ${report.provenance.nodeVersion}`);
  lines.push(`- **Config SHA-256:** ${report.provenance.configHash}`);
  if (report.provenance.repositoryCommit) lines.push(`- **Repository:** ${report.provenance.repositoryCommit}${report.provenance.repositoryDirty ? " (dirty)" : " (clean)"}`);
  lines.push(`\n## Summary`);
  lines.push(
    `- **Nodes:** ${report.summary.nodes} (${report.summary.files} files, ${report.summary.codeSymbols} symbols)`,
  );
  lines.push(`- **Edges:** ${report.summary.edges}`);
  lines.push(`- **Communities:** ${report.summary.communities}`);

  if (report.godNodes.length > 0) {
    lines.push(`\n## God nodes`);
    lines.push(`Highest-degree symbols — the places most changes will ripple through.`);
    lines.push(``);
    lines.push(`| Symbol | Kind | Degree | Consumers | Location |`);
    lines.push(`| --- | --- | ---: | ---: | --- |`);
    for (const g of report.godNodes) {
      lines.push(`| ${g.name} | ${g.kind} | ${g.degree} | ${g.consumers} | ${g.path}:${g.line} |`);
    }
  }

  if (report.surprisingConnections.length > 0) {
    lines.push(`\n## Surprising connections`);
    lines.push(`Cross-community links — coupling between parts of the codebase that live apart.`);
    lines.push(``);
    lines.push(`| From | Relation | To | Communities |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const c of report.surprisingConnections) {
      lines.push(`| ${c.from} | \`${c.relation}\` | ${c.to} | ${c.fromCommunity} → ${c.toCommunity} |`);
    }
  }

  if (report.communities.length > 0) {
    lines.push(`\n## Communities`);
    lines.push(`| # | Size | Top members |`);
    lines.push(`| --- | ---: | --- |`);
    for (const c of report.communities) {
      lines.push(`| ${c.id} | ${c.size} | ${c.topNodes.join(", ")} |`);
    }
  }

  lines.push(`\n## Governance`);
  lines.push(`- **Contexts:** ${report.governance.contexts.total}`);
  for (const [status, count] of Object.entries(report.governance.contexts.byStatus)) {
    if (count) lines.push(`  - ${status}: ${count}`);
  }
  lines.push(`- **Authority:**`);
  for (const [level, count] of Object.entries(report.governance.contexts.byAuthority)) {
    if (count) lines.push(`  - ${level}: ${count}`);
  }
  lines.push(
    `- **Ownership coverage:** ${report.governance.ownershipCoverage}%  ·  **Authority coverage:** ${report.governance.authorityCoverage}%`,
  );
  if (report.governance.contexts.conflicts > 0) {
    lines.push(`- **Conflicts:** ${report.governance.contexts.conflicts}`);
  }
  if (report.governance.contexts.orphan > 0) {
    lines.push(`- **Orphan contexts:** ${report.governance.contexts.orphan}`);
  }
  if (report.governance.warnings.length > 0) {
    lines.push(`- **Warnings:**`);
    for (const w of report.governance.warnings) lines.push(`  - ${w}`);
  }

  lines.push(`\n## Suggested questions`);
  for (const q of report.suggestedQuestions) {
    lines.push(`\n**${q.question}**\n${q.answer}`);
  }

  lines.push(``);
  return lines.join("\n");
}
