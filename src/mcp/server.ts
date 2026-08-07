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
import { object, optional, string, safeParse, type ObjectEntries } from "valibot";
import type { Graph } from "../graph/graph.js";
import { nodeLabel, type GraphNode } from "../graph/nodes.js";
import type { CodeGraphIndex } from "../analyzer/code-graph.js";
import type { LoadedConfig } from "../config/config.js";
import type { AnalysisState } from "../types/analysis-state.js";
import { findPath, neighbors } from "../graph/traversal.js";
import { buildContextBundle } from "../ai/context-builder.js";
import { analyzeImpact } from "../change/impact.js";
import { resolveReviewers } from "../review/resolver.js";
import { computeHealth } from "../health/health.js";
import { matchGlob } from "../utils/glob.js";
import { safeRelativePath, type SafeRelativePath } from "../security/filesystem.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_VERSION = "0.3.0";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: McpContext) => Result<string, string>;
}

export interface McpContext {
  root: string;
  config: LoadedConfig;
  state: AnalysisState;
}

const strField = (description: string) => ({ type: "string", description });
const optStrField = (description: string) => ({ type: "string", description });

const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

function describeNode(ctx: McpContext, name: string): string {
  const { graph } = ctx.state;
  const node = graph.queryByName(name)[0];
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
      lines.push(`- --${edge.relation}--> ${otherLabel} (source: ${provenance})`);
    }
  }
  return lines.join("\n");
}

function describeImpact(ctx: McpContext, base: string | undefined): string {
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
    affectedContexts: impact.value.affectedContexts.map((c) => c.id),
    boundaries: impact.value.boundaries,
    owners: impact.value.owners,
  });
}

function describeReviewers(ctx: McpContext, base: string | undefined): string {
  const { graph, index, contexts, ownership } = ctx.state;
  const impact = analyzeImpact(ctx.root, ctx.config, graph, index, ownership, contexts, {
    ...(base !== undefined ? { base } : {}),
  });
  if (!impact.ok) throw new Error(impact.error.message);
  const review = resolveReviewers(ctx.root, ctx.config, impact.value);
  return json(review);
}

function buildTools(ctx: McpContext): McpTool[] {
  const { graph, index, ownership, contexts } = ctx.state;
  return [
    {
      name: "query",
      description: "Search the repository graph for nodes by name (functions, files, classes, contexts).",
      inputSchema: schema({ name: strField("Node name or fragment") }, ["name"]),
      run: (args) => {
        const name = String(args["name"] ?? "");
        const matches = graph.queryByName(name).slice(0, 200).map(nodeRecord);
        return ok(json({ matches }));
      },
    },
    {
      name: "related",
      description: "Show nodes directly connected to a node, with edge relations.",
      inputSchema: schema({ name: strField("Node name") }, ["name"]),
      run: (args) => {
        const name = String(args["name"] ?? "");
        const node = graph.queryByName(name)[0];
        if (!node) return err(`No node matching "${name}".`);
        const related = neighbors(graph, node.id).map((r) => ({
          node: nodeRecord(r.node),
          edges: r.edges.map((e) => ({ relation: e.relation, source: e.provenance.source })),
        }));
        return ok(json({ node: nodeRecord(node), related }));
      },
    },
    {
      name: "trace",
      description: "Find the shortest path between two nodes.",
      inputSchema: schema({ from: strField("Start node name"), to: strField("End node name") }, ["from", "to"]),
      run: (args) => {
        const fromName = String(args["from"] ?? "");
        const toName = String(args["to"] ?? "");
        const from = graph.queryByName(fromName)[0];
        const to = graph.queryByName(toName)[0];
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
      inputSchema: schema({ target: strField("Symbol name or file path") }, ["target"]),
      run: (args) => {
        const target = String(args["target"] ?? "");
        const bundle = buildContextBundle(graph, index, ownership, contexts, target);
        if (!bundle) return err(`No target matched "${target}". Try a symbol or file name.`);
        return ok(json(bundle));
      },
    },
    {
      name: "explain",
      description: "Explain a node: what it is, what connects it, and the provenance of each connection.",
      inputSchema: schema({ name: strField("Node name") }, ["name"]),
      run: (args) => ok(describeNode(ctx, String(args["name"] ?? ""))),
    },
    {
      name: "governed_by",
      description: "Show living contexts governing a file or symbol.",
      inputSchema: schema({ target: strField("File path or symbol name") }, ["target"]),
      run: (args) => {
        const target = String(args["target"] ?? "");
        const file = resolveTargetFile(graph, index, target);
        if (!file) return err(`Could not resolve "${target}" to a file.`);
        const governing = contexts.filter((c) => c.appliesTo.some((pattern) => matchGlob(pattern, file.toString())));
        return ok(json({ target: file.toString(), contexts: governing.map((c) => ({ id: c.id, title: c.title, status: c.status, authority: c.authority, approvedBy: c.approvedBy })) }));
      },
    },
    {
      name: "owner",
      description: "Show who owns a file or symbol (source + confidence).",
      inputSchema: schema({ target: strField("File path or symbol name") }, ["target"]),
      run: (args) => {
        const target = String(args["target"] ?? "");
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
      inputSchema: schema({ base: optStrField("Base git ref to compare against (e.g. main)") }, []),
      run: (args) => ok(describeImpact(ctx, typeof args["base"] === "string" ? args["base"] : undefined)),
    },
    {
      name: "reviewers",
      description: "Resolve reviewers for the current change: suggested, required, authorityRequired with reasons.",
      inputSchema: schema({ base: optStrField("Base git ref to compare against (e.g. main)") }, []),
      run: (args) => ok(describeReviewers(ctx, typeof args["base"] === "string" ? args["base"] : undefined)),
    },
    {
      name: "health",
      description: "Report living context health: lifecycle coverage, conflicts, orphaned contexts.",
      inputSchema: schema({}, []),
      run: () => {
        const report = computeHealth(graph, contexts, ownership, ctx.config);
        return ok(json(report));
      },
    },
    {
      name: "graph",
      description: "Repository graph summary: node and edge counts, node kinds, declared contexts.",
      inputSchema: schema({}, []),
      run: () => {
        const kindCounts: Record<string, number> = {};
        for (const node of graph.nodes()) kindCounts[node.kind] = (kindCounts[node.kind] ?? 0) + 1;
        return ok(json({ nodes: graph.size, edges: graph.edgeCount, contexts: contexts.length, kinds: kindCounts }));
      },
    },
  ];
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
  const { id = null, method } = message;
  if (typeof method !== "string") {
    return failure(id, -32600, "Invalid request: missing method.");
  }
  if (method.startsWith("notifications/")) return null;
  return handleMethod(ctx, id, method, message.params, tools ?? buildTools(ctx));
}

function handleMethod(
  ctx: McpContext,
  id: number | string | null,
  method: string,
  params: unknown,
  tools: McpTool[],
): string {
  switch (method) {
    case "initialize":
      return success(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "nodenet", version: MCP_SERVER_VERSION },
      });
    case "ping":
      return success(id, {});
    case "tools/list":
      return success(id, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call":
      return handleToolCall(ctx, id, params, tools);
    case "shutdown":
      return success(id, null);
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

function handleToolCall(ctx: McpContext, id: number | string | null, params: unknown, tools: McpTool[]): string {
  if (typeof params !== "object" || params === null) {
    return failure(id, -32602, "Invalid params: expected an object.");
  }
  const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
  if (typeof name !== "string") return failure(id, -32602, "Invalid params: missing tool name.");
  const tool = tools.find((t) => t.name === name);
  if (!tool) return failure(id, -32602, `Unknown tool: ${name}`);

  const argObject = (typeof args === "object" && args !== null && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const validation = validateArgs(tool, argObject);
  if (!validation.ok) {
    return toolResult(id, validation.error, true);
  }

  let result: Result<string, string>;
  try {
    result = tool.run(validation.value, { root: ctx.root, config: ctx.config, state: ctx.state });
  } catch (e) {
    result = err(e instanceof Error ? e.message : String(e));
  }
  if (result.ok) return toolResult(id, result.value, false);
  return toolResult(id, result.error, true);
}

function toolResult(id: number | string | null, text: string, isError: boolean): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
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
  if (keys.length === 0) return ok(args);

  const entries: ObjectEntries = {};
  for (const key of keys) {
    const spec = properties[key];
    if (spec?.type === "string") entries[key] = optional(string());
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
  return ok(parsed.output as Record<string, unknown>);
}
