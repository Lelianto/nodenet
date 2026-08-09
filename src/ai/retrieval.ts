/** Deterministic intent-aware retrieval over the unified graph. */
import crypto from "node:crypto";
import path from "node:path";
import type { LoadedConfig } from "../config/config.js";
import type { Graph } from "../graph/graph.js";
import type { GraphNode } from "../graph/nodes.js";
import { nodeLabel } from "../graph/nodes.js";
import { collectAffected } from "../graph/traversal.js";

export interface AskMatch { id: string; name: string; kind: string; path?: string; score: number; reasons: string[] }
export interface AskConnection { from: string; relation: string; to: string; provenance: string }
export interface RankedFile { path: string; score: number; reasons: string[]; representativeNodeIds: string[] }
export interface AskResult {
  queryId: string;
  question: string;
  intent: "implementation" | "relationship" | "impact" | "ownership" | "governance" | "search";
  matches: AskMatch[];
  connections: AskConnection[];
  /** Small, high-confidence initial read set. */
  primaryFiles: RankedFile[];
  /** Useful evidence which should be read only if the primary answer is insufficient. */
  supportingFiles: RankedFile[];
  /** Lower-confidence graph expansion candidates. */
  expansionCandidates: RankedFile[];
  /** Backwards-compatible alias containing primary paths only. */
  recommendedFiles: string[];
  suggestedNext: string[];
}

export interface AffectedResult { target: AskMatch; depth: number; affected: AskMatch[]; truncated: boolean }

export function askGraph(graph: Graph, question: string, limit = 30): AskResult {
  const rawTokens = tokenize(question);
  const normalizedQuestion = normalizeText(question);
  const intent = classifyIntent(rawTokens);
  const contentTokens = [...new Set(rawTokens.filter((token) => !STOP_WORDS.has(token) && !RELATION_WORDS.has(token)).map(normalizeToken))];
  const matches: AskMatch[] = [];
  for (const node of graph.nodes()) {
    if (["repository", "workspace", "directory"].includes(node.kind)) continue;
    const scored = scoreNode(graph, node, contentTokens, intent, normalizedQuestion);
    if (scored.score <= 0) continue;
    matches.push(toMatch(node, scored.score, scored.reasons));
  }
  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const selected = matches.slice(0, Math.max(1, Math.min(100, limit)));
  const rankedFiles = aggregateFiles(matches).slice(0, Math.max(1, Math.min(100, limit)));
  const primaryCount = rankedFiles.length > 1 && rankedFiles[1]!.score >= rankedFiles[0]!.score * 0.5 ? 2 : Math.min(1, rankedFiles.length);
  const primaryFiles = rankedFiles.slice(0, primaryCount);
  const supportingFiles = rankedFiles.slice(primaryCount, primaryCount + 4);
  const expansionCandidates = rankedFiles.slice(primaryCount + 4, primaryCount + 12);
  const selectedIds = new Set(selected.map((item) => item.id));
  const connections: AskConnection[] = [];
  for (const edge of graph.edges()) {
    if (!selectedIds.has(edge.from) || !selectedIds.has(edge.to) || edge.relation === "contains") continue;
    connections.push({ from: edge.from, relation: edge.relation, to: edge.to, provenance: edge.provenance.source });
    if (connections.length >= 100) break;
  }
  const queryId = crypto.createHash("sha256").update(question).update(graph.metadata.builtAt).digest("hex").slice(0, 24);
  const firstTarget = primaryFiles[0]?.path ?? selected[0]?.id;
  return {
    queryId, question, intent, matches: selected, connections, primaryFiles, supportingFiles, expansionCandidates,
    recommendedFiles: primaryFiles.map((file) => file.path),
    suggestedNext: firstTarget === undefined ? ["Refine the question with a symbol or file name."] : [
      `nodenet context "${firstTarget}" --detail source`,
      ...(primaryFiles.length > 1 ? [`nodenet trace "${primaryFiles[0]!.path}" "${primaryFiles[1]!.path}"`] : []),
      `nodenet affected "${firstTarget}"`,
    ],
  };
}

function scoreNode(graph: Graph, node: GraphNode, tokens: string[], intent: AskResult["intent"], normalizedQuestion: string): { score: number; reasons: string[] } {
  const name = normalizeText(node.name);
  const nodePath = "path" in node && typeof node.path === "string" ? node.path : "";
  const normalizedPath = normalizeText(nodePath);
  const basename = normalizeText(path.basename(nodePath).replace(/\.[^.]+$/, ""));
  let score = 0;
  let matched = 0;
  const reasons: string[] = [];
  for (const token of tokens) {
    let tokenScore = 0;
    if (name === token) tokenScore = 24;
    else if (basename.split(" ").includes(token)) tokenScore = 16;
    else if (name.split(" ").includes(token)) tokenScore = 13;
    else if (name.includes(token)) tokenScore = 9;
    else if (normalizedPath.split(" ").includes(token)) tokenScore = 7;
    else if (normalizedPath.includes(token)) tokenScore = 4;
    if (tokenScore > 0) { score += tokenScore; matched++; reasons.push(`${token} matched ${tokenScore >= 13 ? "name/file" : "path"}`); }
  }
  const pathSegments = nodePath.toLowerCase().split("/").map(normalizeToken);
  const domainMatches = tokens.filter((token) => pathSegments.slice(0, -1).includes(token)).length;
  if (domainMatches > 0) { score += Math.min(12, domainMatches * 6); reasons.push(`domain-directory bonus: ${domainMatches}`); }
  if (matched >= 2) { const bonus = Math.min(24, matched * 6); score += bonus; reasons.push(`multi-term bonus: ${matched}`); }
  if (name.includes(" ") && name.length >= 6 && normalizedQuestion.includes(name)) { score += 20; reasons.push("exact phrase bonus"); }
  const degree = graph.incident(node.id).filter((edge) => edge.relation !== "contains").length;
  score += Math.min(3, Math.log2(degree + 1));
  if (degree > 20) { score -= 8; reasons.push("central-node penalty"); }
  if (intent === "implementation" && isImplementationNode(node)) score += 8;
  if (intent === "implementation" && !isImplementationNode(node)) score -= 15;
  if (intent === "ownership" && ["team", "developer", "role"].includes(node.kind)) score += 14;
  if (intent === "governance" && !isCodeNode(node)) score += 12;
  if (node.kind === "file") score += 5;
  if ("artifactType" in node && node.artifactType === "media" && !tokens.some((token) => ["media", "diagram", "image", "audio", "video", "document", "architecture"].includes(token))) {
    score -= 25; reasons.push("unsolicited-media penalty");
  }
  if ((nodePath.startsWith("test/") || nodePath.includes(".test.")) && !tokens.some((token) => ["test", "spec", "benchmark"].includes(token))) {
    score -= 30; reasons.push("test-file penalty");
  }
  if (nodePath.startsWith("scripts/") && !tokens.includes("script")) { score -= 20; reasons.push("script-file penalty"); }
  return { score: Number(Math.max(0, score).toFixed(3)), reasons: [...new Set(reasons)] };
}

function aggregateFiles(matches: AskMatch[]): RankedFile[] {
  const grouped = new Map<string, AskMatch[]>();
  for (const match of matches) {
    if (!match.path) continue;
    const list = grouped.get(match.path) ?? [];
    list.push(match); grouped.set(match.path, list);
  }
  const files = [...grouped.entries()].map(([file, candidates]): RankedFile => {
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates[0]!.score;
    const second = candidates[1]?.score ?? 0;
    // A file with many similarly named symbols should not outrank the single
    // exact implementation merely because it exposes more declarations.
    const score = Number((top + second * 0.08).toFixed(3));
    return { path: file, score, reasons: [...new Set(candidates.slice(0, 2).flatMap((item) => item.reasons))], representativeNodeIds: candidates.slice(0, 3).map((item) => item.id) };
  });
  return files.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export function affectedByTarget(graph: Graph, config: LoadedConfig, target: string, depth = 2): AffectedResult | null {
  const candidates = graph.queryByName(target);
  const exact = graph.getNode(target as GraphNode["id"]) ?? candidates.find((node) => node.name === target || ("path" in node && node.path === target)) ?? candidates[0];
  if (!exact) return null;
  const maxNodes = Math.min(config.limits.maxTraversalNodes, 500);
  const ids = collectAffected(graph, [exact.id], { maxDepth: Math.max(1, Math.min(depth, config.limits.maxTraversalDepth)), maxNodes }, (edge) => edge.relation !== "contains");
  ids.delete(exact.id);
  const affected = [...ids].map((id) => graph.getNode(id)).filter((node): node is GraphNode => Boolean(node)).map((node) => {
    const degree = graph.incident(node.id).filter((edge) => edge.relation !== "contains").length;
    return toMatch(node, degree, [`reachable within ${depth} graph hop(s)`]);
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { target: toMatch(exact, graph.incident(exact.id).length, ["resolved target"]), depth, affected, truncated: ids.size >= maxNodes };
}

function toMatch(node: GraphNode, score: number, reasons: string[]): AskMatch { const nodePath = "path" in node && typeof node.path === "string" ? node.path : undefined; return { id: node.id, name: nodeLabel(node), kind: node.kind, ...(nodePath ? { path: nodePath } : {}), score, reasons }; }
function tokenize(input: string): string[] { return input.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9_]+/).filter((item) => item.length > 1); }
function normalizeToken(token: string): string { return token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token; }
function normalizeText(input: string): string { return input.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).map(normalizeToken).join(" "); }
function classifyIntent(tokens: string[]): AskResult["intent"] {
  if (tokens.some((token) => ["implement", "implemented", "implementation", "code", "defined", "registered", "detected", "served", "rendered", "calculated", "ingested"].includes(token))) return "implementation";
  if (tokens.some((token) => ["affect", "affected", "impact", "break", "change"].includes(token))) return "impact";
  if (tokens.some((token) => ["owner", "owns", "team", "reviewer"].includes(token))) return "ownership";
  if (tokens.some((token) => ["govern", "governed", "policy", "authority", "approve"].includes(token))) return "governance";
  if (tokens.some((token) => ["connect", "connects", "path", "call", "calls", "depend", "depends"].includes(token))) return "relationship";
  return "search";
}
function isCodeNode(node: GraphNode): boolean { return "path" in node && typeof node.path === "string"; }
function isImplementationNode(node: GraphNode): boolean { return isCodeNode(node) && !["document", "test", "apiOperation", "databaseTable", "infrastructureResource"].includes(node.kind); }
const RELATION_WORDS = new Set(["call", "calls", "called", "import", "imports", "use", "uses", "extend", "extends", "implement", "implements", "connect", "connects", "depend", "depends"]);
const STOP_WORDS = new Set(["what", "where", "which", "who", "how", "why", "does", "the", "and", "for", "from", "into", "with", "between", "show", "find", "are", "is", "was", "were", "be", "been", "being", "their", "its", "protected", "implemented", "yang", "apa", "siapa", "bagaimana", "dari", "dengan", "adalah", "di", "ke"]);
