import fs from "node:fs";
import { Worker } from "node:worker_threads";
import type { McpContext, McpScope } from "./server.js";
import type { McpWorkerPayload } from "./execution-worker.js";

export interface McpExecutionResult {
  response: string | null;
  isolated: boolean;
}

/** Execute a tool call in a terminable worker in built distributions. */
export function executeMcpLineIsolated(
  ctx: McpContext,
  line: string,
  timeoutMs: number,
): Promise<McpExecutionResult> | undefined {
  const workerUrl = new URL("./execution-worker.js", import.meta.url);
  if (!fs.existsSync(workerUrl)) return undefined;
  const payload: McpWorkerPayload = {
    root: ctx.root,
    config: ctx.config,
    graph: ctx.state.graph.toSnapshot(),
    index: ctx.state.index,
    contexts: ctx.state.contexts,
    ownershipRecords: ctx.state.ownership.records,
    warnings: ctx.state.warnings,
    line,
    ...(ctx.authorization ? {
      scopes: [...ctx.authorization.scopes] as McpScope[],
      ...(ctx.authorization.repositoryRoot !== undefined ? { repositoryRoot: ctx.authorization.repositoryRoot } : {}),
    } : {}),
  };
  return new Promise<McpExecutionResult>((resolve, reject) => {
    const worker = new Worker(workerUrl);
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      callback();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`Tool execution exceeded ${timeoutMs}ms and was cancelled.`))), timeoutMs);
    worker.once("message", (message: { ok?: boolean; response?: string | null; error?: string }) => {
      if (message.ok) finish(() => resolve({ response: message.response ?? null, isolated: true }));
      else finish(() => reject(new Error(message.error ?? "Worker execution failed.")));
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(() => reject(new Error(`MCP worker exited with code ${code}.`)));
    });
    worker.postMessage(payload);
  });
}
