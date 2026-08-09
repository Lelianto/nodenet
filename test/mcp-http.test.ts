import { afterEach, describe, expect, it } from "vitest";
import { startMcpHttpServer, type McpHttpServer } from "../src/mcp/http.js";
import { buildFixtureState, fixtureRoot } from "./helpers.js";

describe("experimental MCP HTTP security guards", () => {
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

  it("refuses remote binding without authentication before listening", async () => {
    const root = fixtureRoot("cross-team");
    const state = buildFixtureState(root);
    await expect(startMcpHttpServer({ root, config: state.config, state }, { host: "0.0.0.0", port: 0 })).rejects.toThrow(/bearer token/i);
  });
});
