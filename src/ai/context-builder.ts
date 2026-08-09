/**
 * AI context builder — Minimum Sufficient Context (NodeNet spec §28, §29).
 *
 * Deterministically assembles a context bundle for an AI agent: target
 * code, related code, living context, ownership, authority, change
 * boundaries and AI guidance. Output marks sections by source
 * (SOURCE_CODE / LIVING_CONTEXT / OWNERSHIP / INFERRED) so consuming AI
 * treats source code as evidence, never as instructions (spec §46, §47).
 * Token reduction is NOT the primary goal (spec §28).
 */

import type { SafeRelativePath } from "../security/filesystem.js";
import type { Graph } from "../graph/graph.js";
import { nodeLabel, type GraphNode } from "../graph/nodes.js";
import type { CodeGraphIndex } from "../analyzer/code-graph.js";
import type { ContextRecord } from "../context/schema.js";
import { authorityRank, isBlockingAuthority } from "../authority/authority.js";
import type { OwnershipIndex } from "../ownership/resolver.js";
import { matchGlob } from "../utils/glob.js";
import { containsSecrets } from "../security/secrets.js";

export interface BundleContextRef {
  id: string;
  title: string;
  status: string;
  authority: string;
  appliesTo: string[];
}

export interface BundleOwner {
  file: string;
  owner: string;
  source: string;
  confidence: string;
}

export interface BundleGuidance {
  action: string;
  why: string;
}

export interface BundleCodeEvidence {
  id: string;
  label: string;
  path?: string;
  relation: string;
  direction: "outgoing" | "incoming";
  provenance: string;
  score: number;
  depth: 1 | 2;
  selectionReason: string;
}

export interface ContextBundle {
  target: string;
  codeContext: string[];
  /** Structured, tainted repository evidence; codeContext remains for compatibility. */
  codeEvidence: BundleCodeEvidence[];
  recommendedFiles: string[];
  livingContext: BundleContextRef[];
  ownership: BundleOwner[];
  authority: { contextId: string; approvers: string[] }[];
  changeBoundaries: string[];
  aiGuidance: BundleGuidance[];
  /** Marks whether the bundle text contained secret-like values. */
  secretFlagged: boolean;
  metrics: ContextBundleMetrics;
}

export interface ContextBundleMetrics {
  /** Deterministic, model-neutral estimate (roughly four UTF-16 characters per token). */
  estimatedTokens: number;
  budgetTokens: number;
  truncated: boolean;
  selectedNodes: number;
  omittedNodes: number;
}

export interface ContextBundleOptions {
  /** Soft output budget. Required governance is never discarded to satisfy it. */
  maxTokens?: number;
}

export const DEFAULT_CONTEXT_TOKEN_BUDGET = 2_000;
export const MIN_CONTEXT_TOKEN_BUDGET = 256;
export const MAX_CONTEXT_TOKEN_BUDGET = 32_000;

/** Build an MSC bundle for a query or a specific symbol name. */
export function buildContextBundle(
  graph: Graph,
  index: CodeGraphIndex,
  ownershipIndex: OwnershipIndex,
  contexts: ContextRecord[],
  query: string,
  options: ContextBundleOptions = {},
): ContextBundle | null {
  void index;
  const target = findTarget(graph, query);
  if (!target) return null;

  const targetNode = target.node;
  const targetFile = targetFileOf(targetNode);
  const related = findRelated(graph, targetNode);
  const budgetTokens = normalizeTokenBudget(options.maxTokens);

  const livingContext = contexts.filter((ctx) =>
    targetFile !== undefined && ctx.appliesTo.some((pattern) => matchGlob(pattern, targetFile.toString())),
  );

  const ownership: BundleOwner[] = [];
  if (targetFile) {
    const resolution = ownershipIndex.resolveOwner(targetFile);
    if (resolution) {
      ownership.push({ file: targetFile.toString(), owner: resolution.owner, source: resolution.source, confidence: resolution.confidence });
    }
  }

  const authority = livingContext
    .filter((c) => c.approvedBy.length > 0)
    .map((c) => ({ contextId: c.id, approvers: [...c.approvedBy] }));

  const changeBoundaries = new Set<string>();
  for (const o of ownership) changeBoundaries.add(o.owner);
  for (const a of authority) for (const approver of a.approvers) changeBoundaries.add(approver);

  const aiGuidance = guidance(livingContext);

  const bundle: ContextBundle = {
    target: nodeLabel(targetNode),
    codeContext: [],
    codeEvidence: [],
    recommendedFiles: [],
    livingContext: livingContext.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      authority: c.authority,
      appliesTo: c.appliesTo,
    })),
    ownership,
    authority,
    changeBoundaries: [...changeBoundaries],
    aiGuidance,
    secretFlagged: false,
    metrics: {
      estimatedTokens: 0,
      budgetTokens,
      truncated: false,
      selectedNodes: 0,
      omittedNodes: 0,
    },
  };
  for (const candidate of related) {
    const next = [...bundle.codeContext, nodeLabel(candidate.node)];
    const evidence = evidenceFor(candidate);
    const projected = { ...bundle, codeContext: next, codeEvidence: [...bundle.codeEvidence, evidence] };
    if (estimateTokens(projected) > budgetTokens) continue;
    bundle.codeContext = next;
    bundle.codeEvidence.push(evidence);
  }
  bundle.recommendedFiles = [...new Set(bundle.codeEvidence.map((entry) => entry.path).filter((value): value is string => Boolean(value)))].slice(0, 20);
  bundle.metrics.selectedNodes = bundle.codeContext.length;
  bundle.metrics.omittedNodes = related.length - bundle.codeContext.length;
  bundle.metrics.truncated = bundle.metrics.omittedNodes > 0;
  bundle.metrics.estimatedTokens = estimateTokens(bundle);
  bundle.secretFlagged = containsSecrets(JSON.stringify(bundle));
  return bundle;
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function normalizeTokenBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONTEXT_TOKEN_BUDGET;
  return Math.min(MAX_CONTEXT_TOKEN_BUDGET, Math.max(MIN_CONTEXT_TOKEN_BUDGET, Math.floor(value)));
}

const CALLABLE_KINDS = new Set(["function", "method", "reactComponent", "reactHook"]);

function findTarget(
  graph: Graph,
  query: string,
): { node: GraphNode; score: number } | null {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);

  let best: { node: GraphNode; score: number } | null = null;
  for (const node of graph.nodes()) {
    if (node.id === query) return { node, score: Number.MAX_SAFE_INTEGER };
    if (node.kind === "repository" || node.kind === "workspace" || node.kind === "directory") continue;
    const name = node.name.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (name === token) score += 12;
      else if (name.startsWith(token)) score += 8;
      else if (name.includes(token)) score += 3;
      if (node.kind === "file" && node.path.toLowerCase().includes(token)) score += 2;
    }
    if (score === 0) continue;
    // prefer code symbols over container/file nodes (spec §29 target),
    // and callables (functions/methods/components/hooks) over types: a
    // "modify X" intent targets behavior, not data declarations.
    if (isCodeSymbol(node)) score += 2;
    if (CALLABLE_KINDS.has(node.kind)) score += 14;
    if (!best || score > best.score) {
      best = { node, score };
    } else if (score === best.score && isCodeSymbol(node) && !isCodeSymbol(best.node)) {
      best = { node, score };
    }
  }
  return best;
}

function isCodeSymbol(node: GraphNode): boolean {
  switch (node.kind) {
    case "function":
    case "method":
    case "class":
    case "interface":
    case "typeAlias":
    case "enum":
    case "variable":
    case "reactComponent":
    case "reactHook":
    case "apiRoute":
    case "middleware":
      return true;
    default:
      return false;
  }
}

function targetFileOf(node: GraphNode): SafeRelativePath | undefined {
  if (node.kind === "file") return node.path;
  if ("path" in node) {
    return (node as { path: SafeRelativePath }).path;
  }
  return undefined;
}

interface RelatedCandidate {
  node: GraphNode;
  score: number;
  relation: string;
  direction: "outgoing" | "incoming";
  provenance: string;
  depth: 1 | 2;
}

const RELATION_WEIGHT: Record<string, number> = {
  calls: 10,
  tests: 10,
  implements: 9,
  extends: 9,
  renders: 9,
  references: 8,
  uses: 8,
  imports: 7,
  exports: 6,
  reexports: 6,
  depends_on: 6,
  configures: 6,
  documents: 4,
  defines: 4,
};

function findRelated(graph: Graph, node: GraphNode): RelatedCandidate[] {
  const seen = new Set<string>([node.id]);
  const related: RelatedCandidate[] = [];
  const queue: { id: GraphNode["id"]; depth: 0 | 1; inheritedScore: number }[] = [{ id: node.id, depth: 0, inheritedScore: 0 }];
  while (queue.length > 0 && related.length < 400) {
    const current = queue.shift()!;
    for (const edge of graph.incident(current.id)) {
      if (edge.relation === "contains") continue;
      const direction = edge.from === current.id ? "outgoing" : "incoming";
      const otherId = direction === "outgoing" ? edge.to : edge.from;
      if (seen.has(otherId)) continue;
      seen.add(otherId);
      const other = graph.getNode(otherId);
      if (!other || !isCodeEvidenceNode(other)) continue;
      const depth = (current.depth + 1) as 1 | 2;
      const evidenceBonus = edge.provenance.source === "ast" ? 3 : edge.provenance.source === "inferred" ? 0 : 1;
      const symbolBonus = isCodeSymbol(other) ? 2 : other.kind === "test" ? 4 : 0;
      const directionBonus = edge.relation === "tests" && direction === "incoming" ? 3
        : edge.relation === "calls" && direction === "outgoing" ? 2
          : 0;
      const depthPenalty = depth === 2 ? 4 : 0;
      const score = (RELATION_WEIGHT[edge.relation] ?? 2) + evidenceBonus + symbolBonus + directionBonus - depthPenalty + Math.floor(current.inheritedScore / 4);
      related.push({ node: other, score, relation: edge.relation, direction, provenance: edge.provenance.source, depth });
      if (depth < 2) queue.push({ id: other.id, depth: 1, inheritedScore: score });
    }
  }
  return related
    .sort((a, b) => b.score - a.score || nodeLabel(a.node).localeCompare(nodeLabel(b.node)))
    .slice(0, 200);
}

function isCodeEvidenceNode(node: GraphNode): boolean {
  return ![
    "repository", "workspace", "directory", "team", "developer", "role",
    "businessRule", "architectureDecision", "securityPolicy", "codingConvention",
    "requirement", "specification", "complianceRule", "operationalRule",
    "incidentLearning", "assumption", "domainRule", "externalConstraint",
  ].includes(node.kind);
}

function evidenceFor(candidate: RelatedCandidate): BundleCodeEvidence {
  const path = "path" in candidate.node && typeof candidate.node.path === "string" ? candidate.node.path : undefined;
  return {
    id: candidate.node.id,
    label: nodeLabel(candidate.node),
    ...(path !== undefined ? { path } : {}),
    relation: candidate.relation,
    direction: candidate.direction,
    provenance: candidate.provenance,
    score: candidate.score,
    depth: candidate.depth,
    selectionReason: `${candidate.direction} ${candidate.relation} relation at depth ${candidate.depth}; provenance=${candidate.provenance}; deterministic score=${candidate.score}`,
  };
}

function guidance(contexts: ContextRecord[]): BundleGuidance[] {
  const guidance: BundleGuidance[] = [];
  for (const ctx of contexts) {
    if (isBlockingAuthority(ctx.authority)) {
      guidance.push({
        action: `Do not modify code governed by ${ctx.id}. If the requested change conflicts, create a Context Change Proposal (nodenet context propose ${ctx.id}).`,
        why: `${ctx.id} is ${ctx.authority} — immutable to AI agents; human approval required.`,
      });
    } else if (ctx.status === "ACTIVE" && authorityRank(ctx.authority) >= 3) {
      guidance.push({
        action: `Implementation changes in this area are allowed with review by ${ctx.approvedBy.join(", ") || ctx.owner || "the owning team"}.`,
        why: `${ctx.id} (${ctx.title}) is ACTIVE with authority ${ctx.authority}.`,
      });
    }
  }
  if (guidance.length === 0) {
    guidance.push({
      action: "No declared governance found for this target; proceed with the repository's normal review process.",
      why: "No ACTIVE context applies to this target.",
    });
  }
  return guidance;
}
