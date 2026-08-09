import { afterEach, describe, expect, it } from "vitest";
import { startMcpHttpServer, type McpHttpServer } from "../src/mcp/http.js";
import { buildFixtureState, fixtureRoot, tmpDir, copyFixture } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";

describe("MCP Streamable HTTP security and lifecycle", () => {
  let running: McpHttpServer | undefined;
  afterEach(async () => { await running?.close(); running = undefined; });

  async function start(options: Parameters<typeof startMcpHttpServer>[1] = {}): Promise<McpHttpServer> {
    const root = fixtureRoot("cross-team");
    const state = buildFixtureState(root);
    running = await startMcpHttpServer({
      root,
      config: state.config,
      state,
      protocolState: { initialized: false, ready: false, shutdownRequested: false },
    }, { port: 0, ...options });
    return running;
  }

  it("protects health and MCP requests with authentication and header guards", async () => {
    const server = await start({ token: "test-token", allowedOrigins: ["https://allowed.example"] });
    expect((await fetch(`${server.url}/health`)).status).toBe(401);
    expect((await fetch(`${server.url}/health`, { headers: { Authorization: "Bearer test-token" } })).status).toBe(200);

    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect((await fetch(`${server.url}/mcp`, { method: "POST", body, headers: { Authorization: "Bearer test-token", "Content-Type": "text/plain" } })).status).toBe(415);
    expect((await fetch(`${server.url}/mcp`, { method: "POST", body, headers: { Authorization: "Bearer test-token", "Content-Type": "application/json", Origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${server.url}/mcp`, { method: "POST", body, headers: { Authorization: "Bearer test-token", "Content-Type": "application/json", Accept: "text/plain" } })).status).toBe(406);
  });

  it("returns a deterministic 413 for oversized request bodies", async () => {
    const server = await start({ maxBodyBytes: 64 });
    const response = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", padding: "x".repeat(256) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request_body_too_large" });
  });

  it("assigns, validates, and terminates Streamable HTTP sessions", async () => {
    const server = await start();
    const initialize = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-protocol-version")).toBeTruthy();
    const session = initialize.headers.get("mcp-session-id");
    expect(session).toBeTruthy();
    const missing = await fetch(`${server.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", "Mcp-Session-Id": "unknown" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) });
    expect(missing.status).toBe(404);
    const closed = await fetch(`${server.url}/mcp`, { method: "DELETE", headers: { "Mcp-Session-Id": session! } });
    expect(closed.status).toBe(204);
    expect((await fetch(`${server.url}/mcp`, { headers: { Accept: "text/event-stream" } })).status).toBe(405);
  });

  it("refuses remote binding without authentication before listening", async () => {
    const root = fixtureRoot("cross-team");
    const state = buildFixtureState(root);
    await expect(startMcpHttpServer({ root, config: state.config, state }, { host: "0.0.0.0", port: 0 })).rejects.toThrow(/bearer token/i);
  });

  it("isolates lifecycle and tool scopes per credential", async () => {
    const root = fixtureRoot("cross-team");
    const server = await start({ credentials: [
      { token: "graph-token-123", scopes: ["graph:read"], repositoryRoot: root },
      { token: "context-token-123", scopes: ["context:read"], repositoryRoot: root },
      { token: "wrong-repo-token", scopes: ["graph:read"], repositoryRoot: `${root}-other` },
    ] });
    const post = (token: string, payload: unknown) => fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect((await post("wrong-repo-token", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(403);
    const initialize = { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2024-11-05" } };
    expect((await post("graph-token-123", initialize)).status).toBe(200);
    expect((await post("graph-token-123", { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    const isolated = await (await post("context-token-123", { jsonrpc: "2.0", id: 3, method: "tools/list" })).json() as { error?: { code: number } };
    expect(isolated.error?.code).toBe(-32002);
    expect((await post("context-token-123", { ...initialize, id: 4 })).status).toBe(200);
    expect((await post("context-token-123", { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await (await post("context-token-123", { jsonrpc: "2.0", id: 5, method: "tools/list" })).json() as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["context", "owner", "governed_by"]));
    expect(list.result.tools.map((tool) => tool.name)).not.toContain("graph");
    const forbidden = await (await post("context-token-123", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "graph", arguments: {} } })).json() as { error?: { code: number } };
    expect(forbidden.error?.code).toBe(-32001);
    expect((await fetch(`${server.url}/health`, { headers: { Authorization: "Bearer graph-token-123" } })).status).toBe(403);
  });

  it("rate limits each credential with explicit retry metadata", async () => {
    const server = await start({ rateLimit: { capacity: 1, refillPerSecond: 0.1 } });
    const request = () => fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const first = await request();
    const second = await request();
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
  });

  it("rebuilds stale state and atomically swaps the complete snapshot", async () => {
    const root = tmpDir();
    copyFixture("basic-typescript", root);
    const initial = buildFixtureState(root);
    const ctx = { root, config: initial.config, state: initial };
    let reloads = 0;
    running = await startMcpHttpServer(ctx, {
      port: 0,
      reload: {
        intervalMs: 250,
        load: async () => {
          reloads++;
          const next = buildFixtureState(root);
          return { config: next.config, state: next };
        },
      },
    });
    const before = ctx.snapshotStore!.acquire();
    const changed = path.join(root, "src/math.ts");
    fs.appendFileSync(changed, "\nexport const reloaded = true;\n");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const after = ctx.snapshotStore!.acquire();
    expect(reloads).toBeGreaterThan(0);
    expect(after).not.toBe(before);
    expect(after.state.graph.queryByName("reloaded").length).toBeGreaterThan(0);
  });
});
