/** Dependency-free, loopback-by-default MCP Streamable HTTP transport. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import type { AnalysisState } from "../types/analysis-state.js";
import type { LoadedConfig } from "../config/config.js";
import { captureFreshnessBaseline, staleInputs } from "./security.js";
import { appendAudit } from "../storage/storage.js";
import { executeMcpLineIsolated } from "./execution.js";
import { MCP_PROTOCOL_VERSION, MCP_SCOPES, type McpContext, type McpScope } from "./server.js";
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
  credentials?: McpHttpCredential[];
  rateLimit?: { capacity: number; refillPerSecond: number };
  reload?: {
    intervalMs: number;
    load: () => Promise<{ config: LoadedConfig; state: AnalysisState }>;
  };
}

export interface McpHttpCredential {
  token: string;
  scopes: McpScope[];
  repositoryRoot?: string;
}

export interface McpHttpServer {
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

interface TokenBucket { tokens: number; updatedAt: number }

export async function startMcpHttpServer(ctx: McpContext, options: McpHttpOptions = {}): Promise<McpHttpServer> {
  prepareMcpContext(ctx);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7341;
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? 8;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const rateCapacity = options.rateLimit?.capacity ?? 60;
  const rateRefillPerSecond = options.rateLimit?.refillPerSecond ?? 10;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error("maxBodyBytes must be a positive integer.");
  if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) throw new Error("maxConcurrentRequests must be a positive integer.");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error("requestTimeoutMs must be a positive integer.");
  if (!Number.isInteger(rateCapacity) || rateCapacity < 1 || !Number.isFinite(rateRefillPerSecond) || rateRefillPerSecond <= 0) {
    throw new Error("rateLimit requires a positive integer capacity and positive refillPerSecond.");
  }
  if (options.reload && (!Number.isInteger(options.reload.intervalMs) || options.reload.intervalMs < 250)) {
    throw new Error("reload.intervalMs must be an integer of at least 250ms.");
  }
  let activeRequests = 0;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (options.token && (options.credentials?.length ?? 0) > 0) throw new Error("Configure token or credentials, not both.");
  if (!loopback && !options.token && (options.credentials?.length ?? 0) === 0) throw new Error("A bearer token is required for non-loopback MCP HTTP binding.");
  const credentialHashes = new Set<string>();
  for (const credential of options.credentials ?? []) {
    if (credential.token.length < 8) throw new Error("Credential tokens must contain at least 8 characters.");
    if (credential.scopes.length === 0 || credential.scopes.some((scope) => !(MCP_SCOPES as readonly string[]).includes(scope))) {
      throw new Error("Each credential requires at least one valid MCP scope.");
    }
    const tokenHash = crypto.createHash("sha256").update(credential.token).digest("hex");
    if (credentialHashes.has(tokenHash)) throw new Error("Credential tokens must be unique.");
    credentialHashes.add(tokenHash);
  }
  const sessions = new Map<string, NonNullable<McpContext["protocolState"]>>();
  const buckets = new Map<string, TokenBucket>();
  let reloadRunning = false;
  const reloadTimer = options.reload ? setInterval(() => {
    if (reloadRunning) return;
    const snapshot = ctx.snapshotStore!.acquire();
    const checkCtx: McpContext = { ...ctx, config: snapshot.config, state: snapshot.state };
    if (staleInputs(checkCtx).length === 0) return;
    reloadRunning = true;
    void options.reload!.load()
      .then((next) => {
        const swapped = ctx.snapshotStore!.swap(next.config, next.state);
        ctx.config = swapped.config;
        ctx.state = swapped.state;
        ctx.freshnessBaseline = captureFreshnessBaseline(ctx);
        if (ctx.auditEnabled) appendAudit(ctx.root, { type: "mcp-snapshot-reload", at: new Date().toISOString(), outcome: "success", graphRevision: swapped.revision });
      })
      .catch(() => {
        if (ctx.auditEnabled) appendAudit(ctx.root, { type: "mcp-snapshot-reload", at: new Date().toISOString(), outcome: "error", graphRevision: snapshot.revision });
      })
      .finally(() => { reloadRunning = false; });
  }, options.reload.intervalMs) : undefined;
  reloadTimer?.unref();
  const server = http.createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
    const access = resolveAccess(request.headers.authorization, options, loopback, ctx.root);
    if (!access.authenticated) {
      const unauthenticatedRate = consumeToken(buckets, `unauth:${request.socket.remoteAddress ?? "unknown"}`, rateCapacity, rateRefillPerSecond);
      response.setHeader("X-RateLimit-Limit", String(rateCapacity));
      response.setHeader("X-RateLimit-Remaining", String(unauthenticatedRate.remaining));
      if (!unauthenticatedRate.allowed) {
        response.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(unauthenticatedRate.retryAfterSeconds) });
        response.end(JSON.stringify({ error: "rate_limited" }));
        return;
      }
      response.writeHead(access.forbidden ? 403 : 401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: access.forbidden ? "repository_forbidden" : "unauthorized" }));
      return;
    }
    const rate = consumeToken(buckets, access.sessionKey, rateCapacity, rateRefillPerSecond);
    response.setHeader("X-RateLimit-Limit", String(rateCapacity));
    response.setHeader("X-RateLimit-Remaining", String(rate.remaining));
    if (!rate.allowed) {
      response.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(rate.retryAfterSeconds) });
      response.end(JSON.stringify({ error: "rate_limited" }));
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      if (!access.scopes.has("health:read")) {
        response.writeHead(403, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "missing_scope", requiredScope: "health:read" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, graphRevision: ctx.state.graph.metadata.builtAt }));
      return;
    }
    if (request.url === "/mcp" && request.method === "GET") {
      // This server has no unsolicited server-message stream. Streamable HTTP
      // explicitly permits a server to reject GET when it does not offer SSE.
      response.writeHead(405, { "Content-Type": "application/json", Allow: "POST, DELETE" });
      response.end(JSON.stringify({ error: "server_event_stream_not_available" }));
      return;
    }
    if (request.url === "/mcp" && request.method === "DELETE") {
      const sessionId = headerValue(request.headers["mcp-session-id"]);
      if (!sessionId || !sessions.delete(`${access.sessionKey}:${sessionId}`)) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "session_not_found" }));
        return;
      }
      response.writeHead(204).end();
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
    if (accept && !accept.includes("application/json") && !accept.includes("text/event-stream") && !accept.includes("*/*")) {
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
      const requestedSession = headerValue(request.headers["mcp-session-id"]);
      const sessionKey = requestedSession ? `${access.sessionKey}:${requestedSession}` : access.sessionKey;
      const protocolState = sessions.get(sessionKey) ?? { initialized: false, ready: false, shutdownRequested: false };
      const requestCtx: McpContext = {
        ...ctx,
        protocolState,
        authorization: {
          scopes: access.scopes,
          ...(access.repositoryRoot !== undefined ? { repositoryRoot: access.repositoryRoot } : {}),
        },
      };
      const line = Buffer.concat(chunks).toString("utf8");
      let method: unknown;
      let toolName: string | undefined;
      try {
        const parsed = JSON.parse(line) as { method?: unknown; params?: { name?: unknown } };
        method = parsed.method;
        if (typeof parsed.params?.name === "string") toolName = parsed.params.name;
      } catch { /* sync handler returns parse error */ }
      if (requestedSession && !sessions.has(sessionKey) && method !== "initialize") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "session_not_found" }));
        finish();
        return;
      }
      sessions.set(sessionKey, protocolState);
      if (method === "initialize") {
        const assigned = requestedSession ?? crypto.randomUUID();
        sessions.set(`${access.sessionKey}:${assigned}`, protocolState);
        // Keep the credential-keyed alias for older JSON-only clients.
        sessions.set(access.sessionKey, protocolState);
        response.setHeader("Mcp-Session-Id", assigned);
      }
      const isolated = method === "tools/call" ? executeMcpLineIsolated(requestCtx, line, requestTimeoutMs) : undefined;
      if (!isolated) {
        const result = handleMcpLine(requestCtx, line);
        response.writeHead(result === null ? 202 : 200, { "Content-Type": "application/json" });
        response.end(result ?? "");
        finish();
        return;
      }
      void isolated.then((execution) => {
        if (settled) return;
        if (ctx.auditEnabled) appendAudit(ctx.root, {
          type: "mcp-worker-call",
          at: new Date().toISOString(),
          outcome: "success",
          tool: toolName ?? "unknown",
          clientId: access.sessionKey.slice(0, 16),
          graphRevision: requestCtx.state.graph.metadata.builtAt,
          isolated: execution.isolated,
        });
        response.setHeader("X-NodeNet-Execution", execution.isolated ? "worker" : "inline");
        response.writeHead(execution.response === null ? 202 : 200, { "Content-Type": "application/json" });
        response.end(execution.response ?? "");
        finish();
      }).catch((error: unknown) => {
        if (settled) return;
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = /cancelled|exceeded/i.test(message);
        if (ctx.auditEnabled) appendAudit(ctx.root, {
          type: "mcp-worker-call",
          at: new Date().toISOString(),
          outcome: timedOut ? "cancelled" : "error",
          tool: toolName ?? "unknown",
          clientId: access.sessionKey.slice(0, 16),
          graphRevision: requestCtx.state.graph.metadata.builtAt,
          isolated: true,
        });
        response.writeHead(timedOut ? 504 : 500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: timedOut ? "tool_execution_cancelled" : "tool_execution_failed" }));
        finish();
      });
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
    close: () => {
      if (reloadTimer) clearInterval(reloadTimer);
      return new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
    },
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const selected = Array.isArray(value) ? value[0] : value;
  return selected && /^[A-Za-z0-9._~-]{1,128}$/.test(selected) ? selected : undefined;
}

function consumeToken(
  buckets: Map<string, TokenBucket>,
  key: string,
  capacity: number,
  refillPerSecond: number,
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
  const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1_000;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
  bucket.updatedAt = now;
  const allowed = bucket.tokens >= 1;
  if (allowed) bucket.tokens -= 1;
  buckets.set(key, bucket);
  return {
    allowed,
    remaining: Math.floor(bucket.tokens),
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond)),
  };
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const left = crypto.createHash("sha256").update(actual).digest();
  const right = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

type AccessResult =
  | { authenticated: false; forbidden: boolean }
  | { authenticated: true; scopes: ReadonlySet<McpScope>; repositoryRoot?: string; sessionKey: string };

function resolveAccess(authorization: string | undefined, options: McpHttpOptions, loopback: boolean, expectedRoot: string): AccessResult {
  if ((options.credentials?.length ?? 0) > 0) {
    for (const credential of options.credentials ?? []) {
      if (!safeEqual(authorization, `Bearer ${credential.token}`)) continue;
      if (credential.repositoryRoot && path.resolve(credential.repositoryRoot) !== path.resolve(expectedRoot)) return { authenticated: false, forbidden: true };
      return {
        authenticated: true,
        scopes: new Set(credential.scopes),
        ...(credential.repositoryRoot !== undefined ? { repositoryRoot: credential.repositoryRoot } : {}),
        sessionKey: crypto.createHash("sha256").update(credential.token).digest("hex"),
      };
    }
    return { authenticated: false, forbidden: false };
  }
  if (options.token) {
    if (!safeEqual(authorization, `Bearer ${options.token}`)) return { authenticated: false, forbidden: false };
    return { authenticated: true, scopes: new Set(MCP_SCOPES), sessionKey: crypto.createHash("sha256").update(options.token).digest("hex") };
  }
  if (!loopback) return { authenticated: false, forbidden: false };
  return { authenticated: true, scopes: new Set(MCP_SCOPES), sessionKey: "anonymous-loopback" };
}
