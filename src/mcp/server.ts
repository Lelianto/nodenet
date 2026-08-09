/**
 * NodeNet MCP server (NodeNet spec §29, §61).
 *
 * A minimal, dependency-free Model Context Protocol server over stdio.
 * Newline-delimited JSON-RPC 2.0. Exposes the NodeNet graph, living context,
 * ownership, authority, change impact and reviewer resolution as tools so an
 * AI coding assistant can ask deterministically instead of guessing.
 *
 * Tools never execute repository code and never expose secrets: the
 * `context` tool runs the MSC builder (secret-scanned output) and graph
 * queries return identifiers + provenance only (spec §46, §47).
 *
 * Protocol surface implemented: initialize, notifications/initialized,
 * tools/list, tools/call, ping, shutdown. See docs/adr/005-mcp-server.md.
 */

import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import { number, object, optional, string, safeParse, type ObjectEntries } from "valibot";
import type { Graph } from "../graph/graph.js";
import { nodeLabel, type GraphNode } from "../graph/nodes.js";
import type { CodeGraphIndex } from "../analyzer/code-graph.js";
import type { LoadedConfig } from "../config/config.js";
import type { AnalysisState } from "../types/analysis-state.js";
import { findPath, neighbors } from "../graph/traversal.js";
import {
  buildContextBundle,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  MAX_CONTEXT_TOKEN_BUDGET,
  MIN_CONTEXT_TOKEN_BUDGET,
} from "../ai/context-builder.js";
import { analyzeImpact } from "../change/impact.js";
import { resolveReviewers } from "../review/resolver.js";
import { buildCriticalReview } from "../review/critical.js";
import { computeHealth } from "../health/health.js";
import { buildReport, renderReportMarkdown } from "../report/report.js";
import { matchGlob } from "../utils/glob.js";
import { safeRelativePath, type SafeRelativePath } from "../security/filesystem.js";
import { evidenceClassForSource } from "../graph/edges.js";
import { captureFreshnessBaseline, secureToolOutput, staleInputs, type FreshnessFingerprint } from "./security.js";
import { appendAudit } from "../storage/storage.js";
import path from "node:path";
import fs from "node:fs";
import { McpSnapshotStore } from "./snapshot.js";
import { askGraph, affectedByTarget, leanAskResult } from "../ai/retrieval.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
import { NODENET_VERSION } from "../version.js";

export const MCP_SERVER_VERSION = NODENET_VERSION;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredScope: McpScope;
  run: (args: Record<string, unknown>, ctx: McpContext) => Result<string, string>;
}

export const MCP_SCOPES = ["graph:read", "context:read", "impact:read", "governance:read", "health:read"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export interface McpAuthorization {
  scopes: ReadonlySet<McpScope>;
  repositoryRoot?: string;
}

export interface McpContext {
  root: string;
  config: LoadedConfig;
  state: AnalysisState;
  /** Present on transports; omitted by legacy in-process API callers. */
  protocolState?: { initialized: boolean; ready: boolean; shutdownRequested: boolean };
  freshnessBaseline?: Map<string, FreshnessFingerprint>;
  auditEnabled?: boolean;
  authorization?: McpAuthorization;
  snapshotStore?: McpSnapshotStore;
  toolPreset?: "core" | "governance" | "all";
  tokenLogging?: boolean;
}

/** Prepare transport-level immutable freshness state before serving requests. */
export function prepareMcpContext(ctx: McpContext): McpContext {
  ctx.snapshotStore ??= new McpSnapshotStore(ctx.config, ctx.state);
  ctx.freshnessBaseline ??= captureFreshnessBaseline(ctx);
  ctx.tokenLogging ??= true;
  return ctx;
}

const strField = (description: string) => ({ type: "string", description });
const optStrField = (description: string) => ({ type: "string", description });
const optIntField = (description: string, minimum: number, maximum: number, defaultValue: number) => ({
  type: "integer",
  description,
  minimum,
  maximum,
  default: defaultValue,
});

const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const objectOutput = (...required: string[]) => ({ type: "object", required, additionalProperties: true, "x-schemaVersion": "1" });
const arrayOutput = () => ({ type: "array", "x-schemaVersion": "1" });
const textOutput = () => ({ type: "string", "x-schemaVersion": "1" });

function json(value: unknown): string {
  return JSON.stringify(value);
}

function nodeRecord(node: GraphNode): Record<string, unknown> {
  const record: Record<string, unknown> = { kind: node.kind, name: node.name, id: node.id };
  const p = (node as { path?: string }).path;
  if (typeof p === "string") record["path"] = p;
  if ("line" in node) record["line"] = (node as { line: number }).line;
  return record;
}

/** Resolve a user-supplied target (file path or symbol name) to a file. */
function resolveTargetFile(graph: Graph, index: CodeGraphIndex, target: string): SafeRelativePath | undefined {
  const asSafe = safeRelativePath(target);
  if (asSafe.ok && index.fileNodes.has(asSafe.value)) return asSafe.value;
  const matches = graph.queryByName(target);
  for (const node of matches) {
    if (node.kind === "file") return (node as { path: SafeRelativePath }).path;
    if ("path" in node && typeof node.path === "string") {
      const safe = safeRelativePath(node.path);
      if (safe.ok) return safe.value;
    }
  }
  return undefined;
}

function exactCandidates(graph: Graph, target: string): GraphNode[] {
  const byId = graph.getNode(target as GraphNode["id"]);
  if (byId) return [byId];
  const matches = graph.queryByName(target);
  const exact = matches.filter((node) => node.name === target || ("path" in node && node.path === target));
  // Preserve convenient unique partial lookup, but never let insertion order
  // choose between multiple plausible nodes.
  return exact.length > 0 ? exact : matches;
}

function ambiguityError(target: string, candidates: GraphNode[]): string | undefined {
  if (candidates.length <= 1) return undefined;
  return json({
    code: "ambiguous_target",
    target,
    candidates: candidates.map(nodeRecord),
  });
}

function assertFresh(ctx: McpContext): void {
  const stale = staleInputs(ctx);
  if (stale.length > 0) throw new Error(`Stale analysis state; rebuild the graph before this governance-sensitive call. Changed inputs: ${stale.join(", ")}`);
}

function describeNode(ctx: McpContext, name: string): string {
  const { graph } = ctx.state;
  const candidates = exactCandidates(graph, name);
  const ambiguous = ambiguityError(name, candidates);
  if (ambiguous) throw new Error(ambiguous);
  const node = candidates[0];
  if (!node) throw new Error(`No node matching "${name}".`);
  const lines: string[] = [];
  lines.push(`# ${nodeLabel(node)}`);
  lines.push(`- kind: ${node.kind}`);
  lines.push(`- id: ${node.id}`);
  const p = (node as { path?: string }).path;
  if (typeof p === "string") lines.push(`- path: ${p}`);
  if ("line" in node) lines.push(`- line: ${(node as { line: number }).line}`);
  const incident = graph.incident(node.id);
  if (incident.length > 0) {
    lines.push("");
    lines.push(`## Connections (${incident.length})`);
    for (const edge of incident) {
      const otherId = edge.from === node.id ? edge.to : edge.from;
      const other = graph.getNode(otherId);
      const otherLabel = other ? nodeLabel(other) : otherId;
      const provenance = edge.provenance.source ?? "unknown";
      lines.push(`- --${edge.relation}--> ${otherLabel} (${edge.provenance.classification ?? evidenceClassForSource(edge.provenance.source)}, source: ${provenance})`);
    }
  }
  return lines.join("\n");
}

function describeImpact(ctx: McpContext, base: string | undefined): string {
  assertFresh(ctx);
  const { graph, index, contexts, ownership } = ctx.state;
  const impact = analyzeImpact(ctx.root, ctx.config, graph, index, ownership, contexts, {
    ...(base !== undefined ? { base } : {}),
  });
  if (!impact.ok) throw new Error(impact.error.message);
  return json({
    severity: impact.value.severity,
    severityReasons: impact.value.severityReasons,
    crossTeamBoundary: impact.value.crossTeamBoundary,
    changedFiles: impact.value.changedFiles.map((f) => f.toString()),
    changedSymbols: impact.value.changedSymbols,
    affectedFiles: impact.value.affectedFiles.map((f) => f.toString()),
    approvalFiles: impact.value.approvalFiles.map((f) => f.toString()),
    affectedContexts: impact.value.affectedContexts.map((c) => c.id),
    directContexts: impact.value.directContexts.map((c) => c.id),
    transitiveContexts: impact.value.transitiveContexts.map((c) => c.id),
    boundaries: impact.value.boundaries,
    owners: impact.value.owners,
  });
}

function describeReviewers(ctx: McpContext, base: string | undefined): string {
  assertFresh(ctx);
  const { graph, index, contexts, ownership } = ctx.state;
  const impact = analyzeImpact(ctx.root, ctx.config, graph, index, ownership, contexts, {
    ...(base !== undefined ? { base } : {}),
  });
  if (!impact.ok) throw new Error(impact.error.message);
  const review = resolveReviewers(ctx.root, ctx.config, impact.value);
  return json(review);
}

function describeCriticalReview(ctx: McpContext, base: string | undefined): string {
  assertFresh(ctx);
  const { graph, index, contexts, ownership } = ctx.state;
  const impact = analyzeImpact(ctx.root, ctx.config, graph, index, ownership, contexts, {
    ...(base !== undefined ? { base } : {}),
  });
  if (!impact.ok) throw new Error(impact.error.message);
  const reviewers = resolveReviewers(ctx.root, ctx.config, impact.value);
  return json(buildCriticalReview(ctx.config, impact.value, reviewers));
}

function buildTools(ctx: McpContext): McpTool[] {
  const { graph, index, ownership, contexts } = ctx.state;
  const tools: McpTool[] = [
    {
      name: "ask",
      description: "Retrieve an intent-aware scoped subgraph for a natural-language repository question.",
      requiredScope: "graph:read",
      outputSchema: objectOutput("queryId", "intent", "primaryFiles", "supportingFiles", "recommendedFiles", "suggestedNext"),
      inputSchema: schema({ question: strField("Natural-language repository question"), limit: optIntField("Maximum ranked matches", 1, 20, 5), include: optStrField("Set to full for matches, connections, and ranking explanations") }, ["question"]),
      // Keep the MCP default small enough to preserve the declared object
      // contract under the transport's output budget. Callers can expand it.
      run: (args) => {
        const result = askGraph(graph, String(args["question"] ?? ""), typeof args["limit"] === "number" ? args["limit"] : 5);
        return ok(json(args["include"] === "full" ? result : leanAskResult(result)));
      },
    },
    {
      name: "affected",
      description: "Explore the hypothetical graph blast radius of a symbol or file before making a change.",
      requiredScope: "impact:read",
      outputSchema: objectOutput("target", "depth", "affected", "truncated"),
      inputSchema: schema({ target: strField("Symbol id, exact name, or file path"), depth: optIntField("Maximum graph depth", 1, ctx.config.limits.maxTraversalDepth, 2) }, ["target"]),
      run: (args) => {
        const result = affectedByTarget(graph, ctx.config, String(args["target"] ?? ""), typeof args["depth"] === "number" ? args["depth"] : 2);
        return result ? ok(json(result)) : err(`No target matched "${String(args["target"] ?? "")}".`);
      },
    },
    {
      name: "query",
      description: "Search the repository graph for nodes by name (functions, files, classes, contexts).",
      requiredScope: "graph:read",
      outputSchema: objectOutput("pagination", "matches"),
      inputSchema: schema({
        name: strField("Node name or fragment"),
        cursor: optIntField("Zero-based result offset", 0, 1_000_000, 0),
        limit: optIntField("Maximum items in this page", 1, 200, 50),
      }, ["name"]),
      run: (args) => {
        const name = String(args["name"] ?? "");
        const cursor = typeof args["cursor"] === "number" ? args["cursor"] : 0;
        const limit = typeof args["limit"] === "number" ? args["limit"] : 50;
        const all = graph.queryByName(name);
        const matches = all.slice(cursor, cursor + limit).map(nodeRecord);
        const nextCursor = cursor + matches.length < all.length ? cursor + matches.length : null;
        return ok(json({ pagination: { cursor, limit, selectedItems: matches.length, totalItems: all.length, omittedItems: Math.max(0, all.length - cursor - matches.length), nextCursor }, matches }));
      },
    },
    {
      name: "related",
      description: "Show nodes directly connected to a node, with edge relations.",
      requiredScope: "graph:read",
      outputSchema: objectOutput("node", "pagination", "related"),
      inputSchema: schema({
        name: strField("Node name"),
        cursor: optIntField("Zero-based result offset", 0, 1_000_000, 0),
        limit: optIntField("Maximum items in this page", 1, 200, 50),
      }, ["name"]),
      run: (args) => {
        const name = String(args["name"] ?? "");
        const candidates = exactCandidates(graph, name);
        const ambiguous = ambiguityError(name, candidates);
        if (ambiguous) return err(ambiguous);
        const node = candidates[0];
        if (!node) return err(`No node matching "${name}".`);
        const cursor = typeof args["cursor"] === "number" ? args["cursor"] : 0;
        const limit = typeof args["limit"] === "number" ? args["limit"] : 50;
        const all = neighbors(graph, node.id);
        const related = all.slice(cursor, cursor + limit).map((r) => ({
          node: nodeRecord(r.node),
          edges: r.edges.map((e) => ({ relation: e.relation, source: e.provenance.source, evidence: e.provenance.classification ?? evidenceClassForSource(e.provenance.source) })),
        }));
        const nextCursor = cursor + related.length < all.length ? cursor + related.length : null;
        return ok(json({ node: nodeRecord(node), pagination: { cursor, limit, selectedItems: related.length, totalItems: all.length, omittedItems: Math.max(0, all.length - cursor - related.length), nextCursor }, related }));
      },
    },
    {
      name: "trace",
      description: "Find the shortest path between two nodes.",
      requiredScope: "graph:read",
      outputSchema: arrayOutput(),
      inputSchema: schema({ from: strField("Start node name"), to: strField("End node name") }, ["from", "to"]),
      run: (args) => {
        const fromName = String(args["from"] ?? "");
        const toName = String(args["to"] ?? "");
        const fromCandidates = exactCandidates(graph, fromName);
        const toCandidates = exactCandidates(graph, toName);
        const fromAmbiguous = ambiguityError(fromName, fromCandidates);
        if (fromAmbiguous) return err(fromAmbiguous);
        const toAmbiguous = ambiguityError(toName, toCandidates);
        if (toAmbiguous) return err(toAmbiguous);
        const from = fromCandidates[0];
        const to = toCandidates[0];
        if (!from || !to) return err(`Could not resolve "${!from ? fromName : toName}".`);
        const chain = findPath(
          graph,
          from.id,
          to.id,
          { maxDepth: ctx.config.limits.maxTraversalDepth, maxNodes: ctx.config.limits.maxTraversalNodes },
          (edge) => edge.relation !== "contains",
        );
        if (!chain) return err(`No path found between ${fromName} and ${toName}.`);
        return ok(json(chain.map((e) => ({ from: e.from, relation: e.relation, to: e.to }))));
      },
    },
    {
      name: "context",
      description:
        "Build a Minimum Sufficient Context (MSC) bundle for a target: related code, living context, ownership, authority, change boundaries and AI guidance. Secret-scanned.",
      requiredScope: "context:read",
      outputSchema: objectOutput("target", "codeEvidence", "livingContext", "metrics"),
      inputSchema: schema({
        target: strField("Symbol name or file path"),
        detail: { type: "string", enum: ["route", "map", "evidence", "source"], description: "Progressive field projection" },
        maxTokens: optIntField(
          "Advanced override for the automatic MSC output budget; required governance is always retained",
          MIN_CONTEXT_TOKEN_BUDGET,
          MAX_CONTEXT_TOKEN_BUDGET,
          DEFAULT_CONTEXT_TOKEN_BUDGET,
        ),
      }, ["target"]),
      run: (args) => {
        const target = String(args["target"] ?? "");
        assertFresh(ctx);
        const candidates = exactCandidates(graph, target);
        const ambiguous = ambiguityError(target, candidates);
        if (ambiguous) return err(ambiguous);
        if (candidates.length === 0) return err(`No exact target matched "${target}". Use query to select a stable node id or exact path.`);
        const maxTokens = typeof args["maxTokens"] === "number" ? args["maxTokens"] : undefined;
        const detail = ["route", "map", "evidence", "source"].includes(String(args["detail"] ?? "evidence")) ? String(args["detail"] ?? "evidence") as "route" | "map" | "evidence" | "source" : "evidence";
        const bundle = buildContextBundle(graph, index, ownership, contexts, candidates[0]!.id, { ...(maxTokens !== undefined ? { maxTokens } : {}), detail, ...(detail === "source" ? { root: ctx.root } : {}) });
        if (!bundle) return err(`No target matched "${target}". Try a symbol or file name.`);
        return ok(json(bundle));
      },
    },
    {
      name: "explain",
      description: "Explain a node: what it is, what connects it, and the provenance of each connection.",
      requiredScope: "graph:read",
      outputSchema: textOutput(),
      inputSchema: schema({ name: strField("Node name") }, ["name"]),
      run: (args) => ok(describeNode(ctx, String(args["name"] ?? ""))),
    },
    {
      name: "governed_by",
      description: "Show living contexts governing a file or symbol.",
      requiredScope: "context:read",
      outputSchema: objectOutput("target", "contexts"),
      inputSchema: schema({ target: strField("File path or symbol name") }, ["target"]),
      run: (args) => {
        const target = String(args["target"] ?? "");
        const candidates = exactCandidates(graph, target);
        const ambiguous = ambiguityError(target, candidates);
        if (ambiguous) return err(ambiguous);
        const file = resolveTargetFile(graph, index, target);
        if (!file) return err(`Could not resolve "${target}" to a file.`);
        const governing = contexts.filter((c) => c.appliesTo.some((pattern) => matchGlob(pattern, file.toString())));
        return ok(json({ target: file.toString(), contexts: governing.map((c) => ({ id: c.id, title: c.title, status: c.status, authority: c.authority, approvedBy: c.approvedBy })) }));
      },
    },
    {
      name: "owner",
      description: "Show who owns a file or symbol (source + confidence).",
      requiredScope: "context:read",
      outputSchema: objectOutput("file", "owner", "confidence"),
      inputSchema: schema({ target: strField("File path or symbol name") }, ["target"]),
      run: (args) => {
        const target = String(args["target"] ?? "");
        const candidates = exactCandidates(graph, target);
        const ambiguous = ambiguityError(target, candidates);
        if (ambiguous) return err(ambiguous);
        const file = resolveTargetFile(graph, index, target);
        if (!file) return err(`Could not resolve "${target}" to a file.`);
        const resolution = ownership.resolveOwner(file);
        if (!resolution) return err(`No declared owner for ${file.toString()}.`);
        return ok(json({ file: file.toString(), ...resolution }));
      },
    },
    {
      name: "impact",
      description: "Analyze the current change (git diff) for impact: severity, affected code, living context, ownership boundaries.",
      requiredScope: "impact:read",
      outputSchema: objectOutput("severity", "changedFiles", "affectedFiles"),
      inputSchema: schema({ base: optStrField("Base git ref to compare against (e.g. main)") }, []),
      run: (args) => ok(describeImpact(ctx, typeof args["base"] === "string" ? args["base"] : undefined)),
    },
    {
      name: "reviewers",
      description: "Resolve direct approval reviewers separately from suggested and transitive informational reviewers.",
      requiredScope: "governance:read",
      outputSchema: objectOutput("suggested", "required", "authorityRequired", "informational"),
      inputSchema: schema({ base: optStrField("Base git ref to compare against (e.g. main)") }, []),
      run: (args) => ok(describeReviewers(ctx, typeof args["base"] === "string" ? args["base"] : undefined)),
    },
    {
      name: "critical_review",
      description: "Critically review the current change and return an advisory decision, evidence-backed risks, required reviewers, mitigations, residual risk, and analysis limitations.",
      requiredScope: "governance:read",
      outputSchema: objectOutput("decision", "severity", "risks", "residualRisk"),
      inputSchema: schema({ base: optStrField("Base git ref to compare against (e.g. main)") }, []),
      run: (args) => ok(describeCriticalReview(ctx, typeof args["base"] === "string" ? args["base"] : undefined)),
    },
    {
      name: "health",
      description: "Report living context health: lifecycle coverage, conflicts, orphaned contexts.",
      requiredScope: "health:read",
      outputSchema: objectOutput("contexts"),
      inputSchema: schema({}, []),
      run: () => {
        const report = computeHealth(graph, contexts, ownership, ctx.config);
        return ok(json(report));
      },
    },
    {
      name: "graph",
      description: "Repository graph summary: node and edge counts, node kinds, declared contexts.",
      requiredScope: "graph:read",
      outputSchema: objectOutput("nodes", "edges", "contexts", "kinds"),
      inputSchema: schema({}, []),
      run: () => {
        const kindCounts: Record<string, number> = {};
        for (const node of graph.nodes()) kindCounts[node.kind] = (kindCounts[node.kind] ?? 0) + 1;
        return ok(json({ nodes: graph.size, edges: graph.edgeCount, contexts: contexts.length, kinds: kindCounts }));
      },
    },
    {
      name: "report",
      description:
        "Deterministic highlights report: god nodes (highest-degree symbols), surprising cross-community connections, community summary, governance overview, and suggested questions the graph can answer.",
      requiredScope: "graph:read",
      outputSchema: textOutput(),
      inputSchema: schema({}, []),
      run: () => {
        const report = buildReport(graph, contexts, ownership, ctx.config);
        return ok(renderReportMarkdown(report));
      },
    },
  ];
  const preset = ctx.toolPreset ?? "all";
  if (preset === "all") return tools;
  const core = new Set(["ask", "affected", "query", "related", "trace", "context"]);
  const governance = new Set(["context", "governed_by", "owner", "impact", "reviewers", "critical_review", "health"]);
  return tools.filter((tool) => (preset === "core" ? core : governance).has(tool.name));
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

function success(id: number | string | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function failure(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Process one newline-delimited JSON-RPC message. Returns the response line
 * to write to stdout, or null for notifications (no response required).
 */
export function handleMcpLine(ctx: McpContext, line: string, tools?: McpTool[]): string | null {
  const acquired = ctx.snapshotStore?.acquire();
  const requestCtx = acquired ? { ...ctx, config: acquired.config, state: acquired.state } : ctx;
  let message: RpcMessage;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return failure(null, -32600, "Invalid request: expected a JSON object.");
    }
    message = parsed as RpcMessage;
  } catch {
    return failure(null, -32700, "Parse error: invalid JSON.");
  }
  if (message.jsonrpc !== "2.0") return failure(message.id ?? null, -32600, "Invalid request: jsonrpc must be 2.0.");
  if (message.id !== undefined && message.id !== null && typeof message.id !== "string" && typeof message.id !== "number") {
    return failure(null, -32600, "Invalid request: id must be a string, number, or null.");
  }
  const { id = null, method } = message;
  if (typeof method !== "string") {
    return failure(id, -32600, "Invalid request: missing method.");
  }
  if (method.startsWith("notifications/")) {
    if (method === "notifications/initialized" && requestCtx.protocolState?.initialized && !requestCtx.protocolState.shutdownRequested) {
      requestCtx.protocolState.ready = true;
    }
    return null;
  }
  return handleMethod(requestCtx, id, method, message.params, tools ?? buildTools(requestCtx));
}

function handleMethod(
  ctx: McpContext,
  id: number | string | null,
  method: string,
  params: unknown,
  tools: McpTool[],
): string {
  switch (method) {
    case "initialize": {
      const requested = typeof params === "object" && params !== null
        ? (params as { protocolVersion?: unknown }).protocolVersion
        : undefined;
      if (typeof requested !== "string" || requested.length === 0) {
        return failure(id, -32602, "Initialize requires a protocolVersion string.");
      }
      if (ctx.protocolState?.shutdownRequested) return failure(id, -32000, "Server has shut down.");
      if (ctx.protocolState?.initialized) return failure(id, -32600, "Server is already initialized.");
      if (ctx.protocolState) {
        ctx.protocolState.initialized = true;
        ctx.protocolState.ready = false;
      }
      return success(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "nodenet", version: MCP_SERVER_VERSION },
      });
    }
    case "ping":
      return success(id, {});
    case "tools/list":
      if (ctx.protocolState?.shutdownRequested) return failure(id, -32000, "Server has shut down.");
      if (ctx.protocolState && !ctx.protocolState.ready) return failure(id, -32002, "Server initialization is not complete.");
      return success(id, {
        tools: tools.filter((tool) => isAuthorized(ctx, tool.requiredScope)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}) })),
      });
    case "tools/call":
      if (ctx.protocolState?.shutdownRequested) return failure(id, -32000, "Server has shut down.");
      if (ctx.protocolState && !ctx.protocolState.ready) return failure(id, -32002, "Server initialization is not complete.");
      return handleToolCall(ctx, id, params, tools);
    case "shutdown":
      if (ctx.protocolState && !ctx.protocolState.initialized) return failure(id, -32002, "Server is not initialized.");
      if (ctx.protocolState) ctx.protocolState.shutdownRequested = true;
      return success(id, null);
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

function handleToolCall(ctx: McpContext, id: number | string | null, params: unknown, tools: McpTool[]): string {
  if (typeof params !== "object" || params === null) {
    return failure(id, -32602, "Invalid params: expected an object.");
  }
  const paramRecord = params as Record<string, unknown>;
  const unknownParams = Object.keys(paramRecord).filter((key) => key !== "name" && key !== "arguments");
  if (unknownParams.length > 0) return failure(id, -32602, `Invalid params: unknown properties: ${unknownParams.join(", ")}.`);
  const { name, arguments: args } = paramRecord as { name?: unknown; arguments?: unknown };
  if (typeof name !== "string") return failure(id, -32602, "Invalid params: missing tool name.");
  const tool = tools.find((t) => t.name === name);
  if (!tool) return failure(id, -32602, `Unknown tool: ${name}`);
  if (!isAuthorized(ctx, tool.requiredScope)) return failure(id, -32001, `Forbidden: missing scope ${tool.requiredScope}.`);

  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return failure(id, -32602, "Invalid params: tool arguments must be an object.");
  }
  const argObject = (args ?? {}) as Record<string, unknown>;
  const validation = validateArgs(tool, argObject);
  if (!validation.ok) {
    return toolResult(id, validation.error, true);
  }

  const startedAt = Date.now();
  let result: Result<string, string>;
  try {
    result = tool.run(validation.value, { root: ctx.root, config: ctx.config, state: ctx.state });
  } catch (e) {
    result = err(e instanceof Error ? e.message : String(e));
  }
  if (result.ok) {
    try {
      const outputValidation = validateOutput(tool, result.value);
      if (!outputValidation.ok) {
        auditTool(ctx, id, name, startedAt, "blocked", 0, false);
        return toolResult(id, outputValidation.error, true);
      }
      // `context` already applies a section-aware budget which deliberately
      // retains mandatory governance evidence even when that exceeds the soft
      // caller budget. Do not blindly truncate that evidence a second time.
      const requestedBudget = name === "context"
        ? MAX_CONTEXT_TOKEN_BUDGET
        : typeof validation.value["maxTokens"] === "number" ? validation.value["maxTokens"] : undefined;
      const secured = secureToolOutput(result.value, {
        ...(requestedBudget !== undefined ? { budgetTokens: requestedBudget } : {}),
        secretPatterns: ctx.config.secretPatterns,
        failOnOverflow: name === "context",
        toolName: name,
      });
      auditTool(ctx, id, name, startedAt, "success", secured.estimatedTokens, secured.truncated);
      if (ctx.tokenLogging) appendTokenLog(ctx.root, `mcp:${name}`, secured.emittedTokens);
      return toolResult(id, secured.text, false, secured.structuredContent, ctx.protocolState !== undefined);
    } catch (e) {
      auditTool(ctx, id, name, startedAt, "blocked", 0, false);
      return toolResult(id, e instanceof Error ? e.message : String(e), true);
    }
  }
  try {
    const securedError = secureToolOutput(result.error, { budgetTokens: MAX_CONTEXT_TOKEN_BUDGET, secretPatterns: ctx.config.secretPatterns });
    auditTool(ctx, id, name, startedAt, "error", securedError.estimatedTokens, securedError.truncated);
    return toolResult(id, securedError.text, true);
  } catch {
    auditTool(ctx, id, name, startedAt, "blocked", 0, false);
    return toolResult(id, "Tool error blocked by the secret-disclosure control.", true);
  }
}

function appendTokenLog(root: string, command: string, emittedTokens: number): void {
  const directory = path.join(root, ".nodenet");
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(path.join(directory, "token-log.jsonl"), JSON.stringify({
    at: new Date().toISOString(), command, emittedTokens, pretty: false,
  }) + "\n", { encoding: "utf8", mode: 0o600 });
}

function validateOutput(tool: McpTool, text: string): Result<void, string> {
  const outputSchema = tool.outputSchema;
  if (!outputSchema) return ok(undefined);
  const type = outputSchema["type"];
  if (type === "string") return typeof text === "string" ? ok(undefined) : err(`Output contract violation for ${tool.name}.`);
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { return err(`Output contract violation for ${tool.name}: expected JSON ${String(type)}.`); }
  if (type === "array") return Array.isArray(parsed) ? ok(undefined) : err(`Output contract violation for ${tool.name}: expected an array.`);
  if (type === "object") {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return err(`Output contract violation for ${tool.name}: expected an object.`);
    const required = (outputSchema["required"] as string[] | undefined) ?? [];
    const missing = required.filter((key) => !(key in (parsed as Record<string, unknown>)));
    if (missing.length > 0) return err(`Output contract violation for ${tool.name}: missing ${missing.join(", ")}.`);
    return ok(undefined);
  }
  return err(`Output contract violation for ${tool.name}: unsupported schema type.`);
}

function isAuthorized(ctx: McpContext, scope: McpScope): boolean {
  const authorization = ctx.authorization;
  if (!authorization) return true;
  if (authorization.repositoryRoot && path.resolve(authorization.repositoryRoot) !== path.resolve(ctx.root)) return false;
  return authorization.scopes.has(scope);
}

function auditTool(
  ctx: McpContext,
  id: number | string | null,
  tool: string,
  startedAt: number,
  outcome: "success" | "error" | "blocked",
  estimatedTokens: number,
  truncated: boolean,
): void {
  if (!ctx.auditEnabled) return;
  appendAudit(ctx.root, {
    type: "mcp-tool-call",
    at: new Date().toISOString(),
    requestId: id === null ? "null" : String(id).slice(0, 128),
    tool,
    durationMs: Date.now() - startedAt,
    outcome,
    graphRevision: ctx.state.graph.metadata.builtAt,
    estimatedTokens,
    truncated,
  });
}

function toolResult(id: number | string | null, text: string, isError: boolean, structuredContent?: Record<string, unknown>, structuredOnly = false): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: structuredContent && !isError && structuredOnly ? [] : [{
        type: "text", text,
        _meta: { trust: "untrusted_repository_evidence", executeAsInstructions: false },
      }],
      ...(structuredContent ? { structuredContent } : {}),
      ...(isError ? { isError: true } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Argument validation (Valibot — ADR 002)
// ---------------------------------------------------------------------------

function validateArgs(
  tool: McpTool,
  args: Record<string, unknown>,
): Result<Record<string, unknown>, string> {
  const properties = (tool.inputSchema["properties"] ?? {}) as Record<string, { type?: string }>;
  const required = (tool.inputSchema["required"] as string[]) ?? [];
  const keys = Object.keys(properties);
  const unknown = Object.keys(args).filter((key) => !keys.includes(key));
  if (unknown.length > 0) return err(`Invalid arguments for ${tool.name}: unknown properties: ${unknown.join(", ")}.`);
  if (keys.length === 0) return ok(args);

  const entries: ObjectEntries = {};
  for (const key of keys) {
    const spec = properties[key];
    if (spec?.type === "string") entries[key] = optional(string());
    if (spec?.type === "integer") entries[key] = optional(number());
  }
  if (Object.keys(entries).length === 0) return ok(args);

  const Schema = object(entries);
  const parsed = safeParse(Schema, args);
  if (!parsed.success) {
    const detail = parsed.issues
      .slice(0, 5)
      .map((issue) => `${issue.path?.map((p) => p.key).join(".") ?? "?"}: ${issue.message}`)
      .join("; ");
    return err(`Invalid arguments for ${tool.name}: ${detail}`);
  }
  for (const key of required) {
    if (parsed.output[key] === undefined) return err(`Invalid arguments for ${tool.name}: missing "${key}".`);
  }
  for (const [key, spec] of Object.entries(properties)) {
    const value = parsed.output[key];
    if (typeof value !== "number" || spec.type !== "integer") continue;
    const limits = spec as { minimum?: number; maximum?: number };
    if (!Number.isInteger(value)) return err(`Invalid arguments for ${tool.name}: "${key}" must be an integer.`);
    if (limits.minimum !== undefined && value < limits.minimum) return err(`Invalid arguments for ${tool.name}: "${key}" must be >= ${limits.minimum}.`);
    if (limits.maximum !== undefined && value > limits.maximum) return err(`Invalid arguments for ${tool.name}: "${key}" must be <= ${limits.maximum}.`);
  }
  return ok(parsed.output as Record<string, unknown>);
}
