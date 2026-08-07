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

export interface ContextBundle {
  target: string;
  codeContext: string[];
  livingContext: BundleContextRef[];
  ownership: BundleOwner[];
  authority: { contextId: string; approvers: string[] }[];
  changeBoundaries: string[];
  aiGuidance: BundleGuidance[];
  /** Marks whether the bundle text contained secret-like values. */
  secretFlagged: boolean;
}

/** Build an MSC bundle for a query or a specific symbol name. */
export function buildContextBundle(
  graph: Graph,
  index: CodeGraphIndex,
  ownershipIndex: OwnershipIndex,
  contexts: ContextRecord[],
  query: string,
): ContextBundle | null {
  void index;
  const target = findTarget(graph, query);
  if (!target) return null;

  const targetNode = target.node;
  const targetFile = targetFileOf(targetNode);
  const related = findRelated(graph, targetNode);

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
    codeContext: related.map(nodeLabel),
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
  };
  bundle.secretFlagged = containsSecrets(JSON.stringify(bundle));
  return bundle;
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

function findRelated(graph: Graph, node: GraphNode): GraphNode[] {
  const seen = new Set<string>([node.id]);
  const related: GraphNode[] = [];
  for (const edge of graph.incident(node.id)) {
    if (edge.relation === "contains") continue;
    const otherId = edge.from === node.id ? edge.to : edge.from;
    if (seen.has(otherId)) continue;
    seen.add(otherId);
    const other = graph.getNode(otherId);
    // code context only: skip governance/actor nodes and containers
    if (!other) continue;
    switch (other.kind) {
      case "repository":
      case "workspace":
      case "directory":
      case "team":
      case "developer":
      case "role":
      case "businessRule":
      case "architectureDecision":
      case "securityPolicy":
      case "codingConvention":
      case "requirement":
      case "specification":
      case "complianceRule":
      case "operationalRule":
      case "incidentLearning":
      case "assumption":
      case "domainRule":
      case "externalConstraint":
        continue;
      default:
        break;
    }
    related.push(other);
    if (related.length >= 15) break;
  }
  return related;
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
