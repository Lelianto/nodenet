/** Dependency-free, loopback-by-default MCP HTTP transport. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { McpContext } from "./server.js";
import { handleMcpLine } from "./server.js";

export interface McpHttpOptions {
  host?: string;
  port?: number;
  token?: string;
  maxBodyBytes?: number;
}

export interface McpHttpServer {
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

export async function startMcpHttpServer(ctx: McpContext, options: McpHttpOptions = {}): Promise<McpHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7341;
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const server = http.createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, graphRevision: ctx.state.graph.metadata.builtAt }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (options.token && request.headers.authorization !== `Bearer ${options.token}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) request.destroy(new Error("request body too large"));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      const result = handleMcpLine(ctx, Buffer.concat(chunks).toString("utf8"));
      response.writeHead(result === null ? 202 : 200, { "Content-Type": "application/json" });
      response.end(result ?? "");
    });
    request.on("error", () => {
      if (!response.headersSent) response.writeHead(413, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "request rejected" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve())),
  };
}
