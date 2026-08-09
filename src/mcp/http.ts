/** Dependency-free, loopback-by-default MCP HTTP transport. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import type { McpContext } from "./server.js";
import { handleMcpLine } from "./server.js";
import { prepareMcpContext } from "./server.js";

export interface McpHttpOptions {
  host?: string;
  port?: number;
  token?: string;
  maxBodyBytes?: number;
  allowedOrigins?: string[];
  maxConcurrentRequests?: number;
  requestTimeoutMs?: number;
}

export interface McpHttpServer {
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

export async function startMcpHttpServer(ctx: McpContext, options: McpHttpOptions = {}): Promise<McpHttpServer> {
  prepareMcpContext(ctx);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7341;
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? 8;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error("maxBodyBytes must be a positive integer.");
  if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) throw new Error("maxConcurrentRequests must be a positive integer.");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error("requestTimeoutMs must be a positive integer.");
  let activeRequests = 0;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !options.token) throw new Error("A bearer token is required for non-loopback MCP HTTP binding.");
  const server = http.createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (options.token && !safeEqual(request.headers.authorization, `Bearer ${options.token}`)) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, graphRevision: ctx.state.graph.metadata.builtAt }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const origin = request.headers.origin;
    const allowedOrigins = options.allowedOrigins ?? [];
    if (origin && !allowedOrigins.includes(origin)) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "origin_forbidden" }));
      return;
    }
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      response.writeHead(415, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "content_type_must_be_application_json" }));
      return;
    }
    const accept = request.headers.accept;
    if (accept && !accept.includes("application/json") && !accept.includes("*/*")) {
      response.writeHead(406, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "application_json_not_acceptable" }));
      return;
    }
    if (activeRequests >= maxConcurrentRequests) {
      response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
      response.end(JSON.stringify({ error: "too_many_requests" }));
      return;
    }
    activeRequests++;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      activeRequests--;
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      if (!response.headersSent) response.writeHead(408, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "request_timeout" }));
      finish();
      request.destroy();
    }, requestTimeoutMs);
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        response.writeHead(413, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "request_body_too_large" }));
        finish();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge || settled) return;
      const result = handleMcpLine(ctx, Buffer.concat(chunks).toString("utf8"));
      response.writeHead(result === null ? 202 : 200, { "Content-Type": "application/json" });
      response.end(result ?? "");
      finish();
    });
    request.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "request_rejected" }));
      }
      finish();
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

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
