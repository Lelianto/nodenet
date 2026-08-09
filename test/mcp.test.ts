import { describe, it, expect } from "vitest";
import { handleMcpLine, MCP_PROTOCOL_VERSION, prepareMcpContext, type McpContext, type McpTool } from "../src/mcp/server.js";
import { ok } from "../src/types/result.js";
import { makeNodeId } from "../src/analyzer/code-graph.js";
import { safeRelativePath } from "../src/security/filesystem.js";
import { appendAudit, verifyAuditChain } from "../src/storage/storage.js";
import { McpSnapshotStore } from "../src/mcp/snapshot.js";
import { makeGitRepo, buildFixtureState, fixtureRoot, tmpDir, copyFixture } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";

interface ResponseLike {
  jsonrpc?: string;
  id?: number | string | null;
  result?: { content?: { type: string; text: string }[]; isError?: boolean; [k: string]: unknown };
  error?: { code: number; message: string };
}

function send(ctx: McpContext, line: string): ResponseLike | null {
  const out = handleMcpLine(ctx, line);
  if (out === null) return null;
  return JSON.parse(out) as ResponseLike;
}

function toolText(res: ResponseLike): string {
  return res.result?.content?.[0]?.text ?? "";
}

function call(ctx: McpContext, id: number, name: string, args: Record<string, unknown> = {}): ResponseLike | null {
  return send(ctx, JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }));
}

describe("MCP server protocol", () => {
  const root = fixtureRoot("cross-team");
  const state = buildFixtureState(root);
  const ctx: McpContext = { root, config: state.config, state };

  it("handles initialize", () => {
    const res = send(ctx, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }));
    expect(res?.result?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(res?.result?.capabilities).toHaveProperty("tools");
    expect(res?.result?.serverInfo?.name).toBe("nodenet");
  });

  it("ignores notifications (null response)", () => {
    const res = send(ctx, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res).toBeNull();
  });

  it("responds to ping", () => {
    const res = send(ctx, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }));
    expect(res?.id).toBe(2);
    expect(res?.error).toBeUndefined();
  });

  it("lists tools", () => {
    const res = send(ctx, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
    const tools = res?.result?.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["ask", "affected", "query", "related", "trace", "context", "explain", "governed_by", "owner", "impact", "reviewers", "critical_review", "health", "graph", "report"]),
    );
    expect(tools.every((tool) => (tool as { outputSchema?: unknown }).outputSchema !== undefined)).toBe(true);
  });

  it("retrieves natural-language matches and hypothetical affected nodes", () => {
    const ask = call(ctx, 31, "ask", { question: "what connects checkout to payment" });
    expect(JSON.parse(toolText(ask!)).matches.length).toBeGreaterThan(0);
    const affected = call(ctx, 32, "affected", { target: "PaymentService", depth: 2 });
    expect(JSON.parse(toolText(affected!)).affected.length).toBeGreaterThan(0);
  });

  it("rejects malformed JSON with a parse error", () => {
    const res = send(ctx, "not json");
    expect(res?.error?.code).toBe(-32700);
  });

  it("rejects unknown methods", () => {
    const res = send(ctx, JSON.stringify({ jsonrpc: "2.0", id: 5, method: "bogus" }));
    expect(res?.error?.code).toBe(-32601);
  });

  it("rejects unknown tools", () => {
    const res = call(ctx, 6, "nope");
    expect(res?.error?.code).toBe(-32602);
  });

  it("strictly validates JSON-RPC and advertised input schemas", () => {
    const badVersion = send(ctx, JSON.stringify({ jsonrpc: "1.0", id: 7, method: "ping" }));
    expect(badVersion?.error?.code).toBe(-32600);
    expect(call(ctx, 8, "query", { name: "PaymentService", extra: true })?.result?.isError).toBe(true);
    expect(call(ctx, 9, "context", { target: "PaymentService", maxTokens: 256.5 })?.result?.isError).toBe(true);
    expect(call(ctx, 91, "context", { target: "PaymentService", maxTokens: 255 })?.result?.isError).toBe(true);
    const arrayArgs = send(ctx, JSON.stringify({ jsonrpc: "2.0", id: 911, method: "tools/call", params: { name: "graph", arguments: [] } }));
    expect(arrayArgs?.error?.code).toBe(-32602);
    const extraParams = send(ctx, JSON.stringify({ jsonrpc: "2.0", id: 912, method: "tools/call", params: { name: "graph", arguments: {}, extra: true } }));
    expect(extraParams?.error?.code).toBe(-32602);
    expect(call(ctx, 913, "query", { name: "Service", limit: 0 })?.result?.isError).toBe(true);
  });

  it("fails closed when any tool result contains a secret", () => {
    const tools: McpTool[] = [{
      name: "unsafe",
      description: "test",
      requiredScope: "graph:read",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      run: () => ok("token=ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"),
    }];
    const out = handleMcpLine(ctx, JSON.stringify({ jsonrpc: "2.0", id: 92, method: "tools/call", params: { name: "unsafe", arguments: {} } }), tools);
    const res = JSON.parse(out!) as ResponseLike;
    expect(res.result?.isError).toBe(true);
    expect(toolText(res)).toMatch(/blocked/i);
    expect(toolText(res)).not.toContain("ghp_");
  });

  it("blocks successful tool output that violates its advertised schema", () => {
    const invalid: McpTool = {
      name: "invalid-output",
      description: "test",
      requiredScope: "graph:read",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      outputSchema: { type: "object", required: ["value"] },
      run: () => ok("[]"),
    };
    const out = handleMcpLine(ctx, JSON.stringify({ jsonrpc: "2.0", id: 925, method: "tools/call", params: { name: invalid.name, arguments: {} } }), [invalid]);
    const res = JSON.parse(out!) as ResponseLike;
    expect(res.result?.isError).toBe(true);
    expect(toolText(res)).toMatch(/output contract violation/i);
  });

  it("applies configured secret patterns and structured evidence envelopes", () => {
    const customCtx: McpContext = { ...ctx, config: { ...ctx.config, secretPatterns: [...ctx.config.secretPatterns, "INTERNAL-[0-9]{4}"] } };
    const secretTool: McpTool = {
      name: "custom-secret",
      description: "test",
      requiredScope: "graph:read",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      run: () => ok("INTERNAL-1234"),
    };
    const blocked = handleMcpLine(customCtx, JSON.stringify({ jsonrpc: "2.0", id: 913, method: "tools/call", params: { name: "custom-secret", arguments: {} } }), [secretTool]);
    expect(toolText(JSON.parse(blocked!) as ResponseLike)).not.toContain("INTERNAL-1234");

    const arrayTool: McpTool = { ...secretTool, name: "array", run: () => ok('[{"name":"evidence"}]') };
    const arrayOut = handleMcpLine(ctx, JSON.stringify({ jsonrpc: "2.0", id: 914, method: "tools/call", params: { name: "array", arguments: {} } }), [arrayTool]);
    const arrayRes = JSON.parse(arrayOut!) as ResponseLike;
    expect(arrayRes.result?.structuredContent).toMatchObject({ schemaVersion: "1", trust: "untrusted_repository_evidence" });

    const unsafeRegexCtx: McpContext = { ...ctx, config: { ...ctx.config, secretPatterns: ["(a+)+$"] } };
    const unsafeRegexOut = handleMcpLine(unsafeRegexCtx, JSON.stringify({ jsonrpc: "2.0", id: 9141, method: "tools/call", params: { name: "array", arguments: {} } }), [arrayTool]);
    expect((JSON.parse(unsafeRegexOut!) as ResponseLike).result?.isError).toBe(true);
  });

  it("enforces transport lifecycle transitions", () => {
    const transportCtx: McpContext = {
      ...ctx,
      protocolState: { initialized: false, ready: false, shutdownRequested: false },
    };
    expect(send(transportCtx, JSON.stringify({ jsonrpc: "2.0", id: 915, method: "tools/list" }))?.error?.code).toBe(-32002);
    const initialized = send(transportCtx, JSON.stringify({ jsonrpc: "2.0", id: 916, method: "initialize", params: { protocolVersion: "2099-01-01" } }));
    expect(initialized?.result?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(send(transportCtx, JSON.stringify({ jsonrpc: "2.0", id: 917, method: "tools/list" }))?.error?.code).toBe(-32002);
    expect(send(transportCtx, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
    expect(send(transportCtx, JSON.stringify({ jsonrpc: "2.0", id: 918, method: "tools/list" }))?.error).toBeUndefined();
    expect(send(transportCtx, JSON.stringify({ jsonrpc: "2.0", id: 919, method: "shutdown" }))?.error).toBeUndefined();
    expect(send(transportCtx, JSON.stringify({ jsonrpc: "2.0", id: 920, method: "tools/list" }))?.error?.code).toBe(-32000);
  });

  it("filters tools and rejects calls outside the authorized scope and repository", () => {
    const graphOnly: McpContext = { ...ctx, authorization: { scopes: new Set(["graph:read"]) } };
    const listed = send(graphOnly, JSON.stringify({ jsonrpc: "2.0", id: 921, method: "tools/list" }));
    const names = (listed?.result?.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain("graph");
    expect(names).not.toContain("context");
    expect(call(graphOnly, 922, "graph")?.error).toBeUndefined();
    expect(call(graphOnly, 923, "context", { target: "PaymentService" })?.error?.code).toBe(-32001);

    const wrongRepository: McpContext = { ...graphOnly, authorization: { scopes: new Set(["graph:read"]), repositoryRoot: path.join(root, "other") } };
    expect(call(wrongRepository, 924, "graph")?.error?.code).toBe(-32001);
  });
});

describe("MCP snapshot and audit integrity", () => {
  it("atomically swaps config and analysis state while acquired snapshots remain stable", () => {
    const first = buildFixtureState(fixtureRoot("cross-team"));
    const second = buildFixtureState(fixtureRoot("basic-typescript"));
    const store = new McpSnapshotStore(first.config, first);
    const acquired = store.acquire();
    const swapped = store.swap(second.config, second);
    expect(acquired.state.graph).toBe(first.graph);
    expect(store.acquire()).toBe(swapped);
    expect(store.acquire().state.graph).toBe(second.graph);
    expect(acquired.state.graph).not.toBe(store.acquire().state.graph);
  });

  it("detects tampering in hash-chained audit records", () => {
    const root = tmpDir();
    appendAudit(root, { type: "first", at: "2026-01-01T00:00:00.000Z", outcome: "success" });
    appendAudit(root, { type: "second", at: "2026-01-01T00:00:01.000Z", outcome: "success" });
    expect(verifyAuditChain(root)).toMatchObject({ valid: true, verifiedRecords: 2 });
    const file = path.join(root, ".nodenet/audit.jsonl");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"outcome":"success"', '"outcome":"failure"'));
    expect(verifyAuditChain(root)).toMatchObject({ valid: false, errorLine: 1 });
  });
});

describe("MCP tools", () => {
  const root = fixtureRoot("cross-team");
  const state = buildFixtureState(root);
  const ctx: McpContext = { root, config: state.config, state };

  it("query returns matching nodes", () => {
    const res = call(ctx, 10, "query", { name: "PaymentService" });
    expect(res?.error).toBeUndefined();
    const body = JSON.parse(toolText(res!)) as { matches: { kind: string; path?: string }[] };
    expect(body.matches.some((m) => m.kind === "file" && m.path === "src/payment/PaymentService.ts")).toBe(true);
  });

  it("query and related expose deterministic cursor pagination metadata", () => {
    const first = call(ctx, 101, "query", { name: "Service", limit: 1 });
    const firstBody = JSON.parse(toolText(first!)) as { matches: { id: string }[]; pagination: { selectedItems: number; totalItems: number; omittedItems: number; nextCursor: number | null } };
    expect(firstBody.pagination.selectedItems).toBe(1);
    expect(firstBody.pagination.totalItems).toBeGreaterThan(1);
    expect(firstBody.pagination.nextCursor).toBe(1);
    const second = call(ctx, 102, "query", { name: "Service", cursor: firstBody.pagination.nextCursor!, limit: 1 });
    const secondBody = JSON.parse(toolText(second!)) as typeof firstBody;
    expect(secondBody.matches[0]?.id).not.toBe(firstBody.matches[0]?.id);

    const related = call(ctx, 103, "related", { name: "createSettlement", limit: 1 });
    const relatedBody = JSON.parse(toolText(related!)) as { related: unknown[]; pagination: { selectedItems: number; totalItems: number; omittedItems: number } };
    expect(relatedBody.pagination.selectedItems).toBe(1);
    expect(relatedBody.pagination.totalItems).toBeGreaterThanOrEqual(relatedBody.related.length);
    expect(relatedBody.pagination.omittedItems).toBe(relatedBody.pagination.totalItems - 1);
  });

  it("related returns neighbors with relations", () => {
    const res = call(ctx, 11, "related", { name: "createSettlement" });
    expect(res?.error).toBeUndefined();
    const body = JSON.parse(toolText(res!)) as { related: { node: { name: string } }[] };
    expect(body.related.length).toBeGreaterThan(0);
  });

  it("trace finds a path between two files", () => {
    const res = call(ctx, 12, "trace", { from: "CheckoutService", to: "PaymentService" });
    expect(res?.error).toBeUndefined();
    const body = JSON.parse(toolText(res!)) as { from: string; relation: string; to: string }[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it("context builds an MSC bundle with governance and secret flag", () => {
    const res = call(ctx, 13, "context", { target: "createSettlement" });
    expect(res?.error).toBeUndefined();
    const bundle = JSON.parse(toolText(res!)) as {
      target: string;
      livingContext: { id: string }[];
      aiGuidance: { action: string }[];
      codeEvidence: { id: string; relation: string; direction: string; provenance: string; score: number; depth: number; selectionReason: string }[];
      recommendedFiles: string[];
      secretFlagged: boolean;
      metrics: { estimatedTokens: number; budgetTokens: number; truncated: boolean };
    };
    expect(bundle.livingContext.map((c) => c.id)).toEqual(expect.arrayContaining(["PAYMENT-003", "SEC-009"]));
    expect(bundle.aiGuidance.length).toBeGreaterThan(0);
    expect(bundle.codeEvidence.length).toBeGreaterThan(0);
    expect(bundle.codeEvidence.every((entry) => entry.id && entry.relation && entry.direction && entry.provenance && entry.selectionReason && Number.isFinite(entry.score))).toBe(true);
    expect(bundle.codeEvidence.some((entry) => entry.depth === 2)).toBe(true);
    expect(bundle.recommendedFiles.length).toBeGreaterThan(0);
    expect(typeof bundle.secretFlagged).toBe("boolean");
    expect(bundle.metrics.budgetTokens).toBe(2000);
    expect(bundle.metrics.estimatedTokens).toBeGreaterThan(0);
  });

  it("context honors and reports a caller-supplied token budget", () => {
    const res = call(ctx, 131, "context", { target: "createSettlement", maxTokens: 256 });
    expect(res?.error).toBeUndefined();
    const bundle = JSON.parse(toolText(res!)) as {
      livingContext: { id: string }[];
      metrics: { budgetTokens: number; selectedNodes: number; omittedNodes: number };
    };
    expect(bundle.metrics.budgetTokens).toBe(256);
    expect(bundle.metrics.omittedNodes).toBeGreaterThanOrEqual(0);
    expect(bundle.livingContext.map((c) => c.id)).toEqual(expect.arrayContaining(["PAYMENT-003", "SEC-009"]));
  });

  it("explain describes a node and its connections", () => {
    const res = call(ctx, 14, "explain", { name: "createSettlement" });
    expect(res?.error).toBeUndefined();
    expect(toolText(res!)).toContain("createSettlement");
  });

  it("owner resolves ownership", () => {
    const res = call(ctx, 15, "owner", { target: "src/payment/PaymentService.ts" });
    expect(res?.error).toBeUndefined();
    const body = JSON.parse(toolText(res!)) as { owner: string; confidence: string };
    expect(body.owner).toBe("payment-team");
    expect(body.confidence).toBe("AUTHORITATIVE");
  });

  it("governed_by returns PAYMENT-003 and SEC-009", () => {
    const res = call(ctx, 16, "governed_by", { target: "src/payment/PaymentService.ts" });
    expect(res?.error).toBeUndefined();
    const body = JSON.parse(toolText(res!)) as { contexts: { id: string }[] };
    expect(body.contexts.map((c) => c.id)).toEqual(["PAYMENT-003", "SEC-009"]);
  });

  it("graph returns summary", () => {
    const res = call(ctx, 17, "graph");
    expect(res?.error).toBeUndefined();
    const body = JSON.parse(toolText(res!)) as { nodes: number; edges: number; contexts: number };
    expect(body.nodes).toBeGreaterThan(0);
    expect(body.contexts).toBe(2);
  });

  it("health returns a report", () => {
    const res = call(ctx, 18, "health");
    expect(res?.error).toBeUndefined();
    const body = JSON.parse(toolText(res!)) as { contexts: { total: number } };
    expect(body.contexts.total).toBe(2);
  });

  it("missing required args produce an isError tool result", () => {
    const res = call(ctx, 19, "query", {});
    expect(res?.result?.isError).toBe(true);
    expect(toolText(res!)).toContain("Invalid arguments");
  });

  it("impact returns an explainable error outside a git repo", () => {
    const dir = tmpDir();
    copyFixture("cross-team", dir);
    const noGit = buildFixtureState(dir);
    const noGitCtx: McpContext = { root: dir, config: noGit.config, state: noGit };
    const res = call(noGitCtx, 20, "impact");
    expect(res?.result?.isError).toBe(true);
    expect(toolText(res!)).toMatch(/git/i);
  });

  it("fails governance-sensitive retrieval when repository inputs become stale", () => {
    const dir = tmpDir();
    copyFixture("cross-team", dir);
    const fresh = buildFixtureState(dir);
    const freshCtx: McpContext = { root: dir, config: fresh.config, state: fresh };
    const changed = path.join(dir, "src/payment/PaymentService.ts");
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(changed, future, future);
    const res = call(freshCtx, 21, "context", { target: "PaymentService" });
    expect(res?.result?.isError).toBe(true);
    expect(toolText(res!)).toMatch(/stale analysis state/i);
  });

  it("detects governance edits with rolled-back mtimes and deleted inputs", () => {
    const dir = tmpDir();
    copyFixture("cross-team", dir);
    const fresh = buildFixtureState(dir);
    const freshCtx = prepareMcpContext({ root: dir, config: fresh.config, state: fresh });
    const governance = path.join(dir, ".nodenet/context.json");
    const before = fs.statSync(governance);
    const original = fs.readFileSync(governance, "utf8");
    fs.writeFileSync(governance, original.replace("Settlement Processing Rule", "Settlement Processing RulE"));
    fs.utimesSync(governance, before.atime, before.mtime);
    const changed = call(freshCtx, 22, "context", { target: "PaymentService" });
    expect(changed?.result?.isError).toBe(true);
    expect(toolText(changed!)).toMatch(/\.nodenet\/context\.json/i);

    const sourceCtx = prepareMcpContext({ root: dir, config: fresh.config, state: fresh });
    fs.unlinkSync(path.join(dir, "src/payment/SettlementSchema.ts"));
    const deleted = call(sourceCtx, 23, "impact");
    expect(deleted?.result?.isError).toBe(true);
    expect(toolText(deleted!)).toMatch(/deleted/i);
  });

  it("rejects ambiguous targets across target-based public tools", () => {
    const dir = tmpDir();
    copyFixture("cross-team", dir);
    const duplicate = buildFixtureState(dir);
    const duplicatePath = safeRelativePath("src/other/PaymentService.ts");
    if (!duplicatePath.ok) throw duplicatePath.error;
    duplicate.graph.addNode({
      kind: "file",
      id: makeNodeId("file", duplicatePath.value),
      name: "PaymentService.ts",
      path: duplicatePath.value,
      language: "typescript",
      isTest: false,
    });
    const duplicateCtx: McpContext = { root: dir, config: duplicate.config, state: duplicate };
    for (const [name, args] of [
      ["related", { name: "PaymentService.ts" }],
      ["context", { target: "PaymentService.ts" }],
      ["explain", { name: "PaymentService.ts" }],
      ["owner", { target: "PaymentService.ts" }],
      ["governed_by", { target: "PaymentService.ts" }],
      ["trace", { from: "PaymentService.ts", to: "CheckoutService" }],
    ] as const) {
      const res = call(duplicateCtx, 24, name, args);
      expect(res?.result?.isError, name).toBe(true);
      expect(toolText(res!), name).toContain("ambiguous_target");
    }
  });
});

describe("MCP impact over a real git PR", () => {
  it("impact and reviewers tools resolve the cross-team change", () => {
    const dir = makeGitRepo("cross-team", (root) => {
      const file = path.join(root, "src/checkout/CheckoutService.ts");
      const content = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, content + "\nexport function checkoutV2(cartId: string): string {\n  return checkout(cartId) + \"-v2\";\n}\n");
    });
    const state = buildFixtureState(dir);
    const ctx: McpContext = { root: dir, config: state.config, state };

    const impactRes = call(ctx, 30, "impact", { base: "main" });
    expect(impactRes?.result?.isError).toBeUndefined();
    const impact = JSON.parse(toolText(impactRes!)) as { severity: string; crossTeamBoundary: boolean };
    expect(impact.severity).toBe("HIGH");
    expect(impact.crossTeamBoundary).toBe(true);

    const reviewRes = call(ctx, 31, "reviewers", { base: "main" });
    expect(reviewRes?.result?.isError).toBeUndefined();
    const review = JSON.parse(toolText(reviewRes!)) as {
      required: { target: string }[];
      authorityRequired: { target: string }[];
    };
    expect(review.required.map((r) => r.target)).toContain("payment-team");
    expect(review.authorityRequired.map((r) => r.target)).toContain("finance-team");

    const criticalRes = call(ctx, 32, "critical_review", { base: "main" });
    expect(criticalRes?.result?.isError).toBeUndefined();
    const critical = JSON.parse(toolText(criticalRes!)) as {
      decision: string;
      risks: { id: string; mitigation: string; evidence: string[] }[];
      requiredReviewers: string[];
      residualRisk: string;
      limitations: string[];
    };
    expect(critical.decision).toBe("CAUTION");
    expect(critical.risks.map((risk) => risk.id)).toContain("cross-team-boundary");
    expect(critical.risks.every((risk) => risk.mitigation.length > 0 && risk.evidence.length > 0)).toBe(true);
    expect(critical.requiredReviewers).toContain("payment-team");
    expect(critical.residualRisk).toMatch(/runtime behavior/i);
    expect(critical.limitations.length).toBeGreaterThan(0);
  });
});
