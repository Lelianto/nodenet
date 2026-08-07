import { describe, it, expect } from "vitest";
import { handleMcpLine, MCP_PROTOCOL_VERSION, type McpContext } from "../src/mcp/server.js";
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
      expect.arrayContaining(["query", "related", "trace", "context", "explain", "governed_by", "owner", "impact", "reviewers", "health", "graph"]),
    );
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
      secretFlagged: boolean;
    };
    expect(bundle.livingContext.map((c) => c.id)).toEqual(expect.arrayContaining(["PAYMENT-003", "SEC-009"]));
    expect(bundle.aiGuidance.length).toBeGreaterThan(0);
    expect(typeof bundle.secretFlagged).toBe("boolean");
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
  });
});
