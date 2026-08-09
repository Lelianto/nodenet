import { parentPort } from "node:worker_threads";
import { Graph } from "../graph/graph.js";
import { ownershipIndexFromRecords } from "../ownership/resolver.js";
import { handleMcpLine, type McpContext, type McpScope } from "./server.js";
import type { LoadedConfig } from "../config/config.js";
import type { CodeGraphIndex } from "../analyzer/code-graph.js";
import type { ContextRecord } from "../context/schema.js";
import type { OwnershipRecord } from "../ownership/schema.js";
import type { GraphSnapshot } from "../graph/graph.js";

export interface McpWorkerPayload {
  root: string;
  config: LoadedConfig;
  graph: GraphSnapshot;
  index: CodeGraphIndex;
  contexts: ContextRecord[];
  ownershipRecords: OwnershipRecord[];
  warnings: string[];
  line: string;
  scopes?: McpScope[];
  repositoryRoot?: string;
}

if (parentPort) {
  parentPort.on("message", (payload: McpWorkerPayload) => {
    try {
      const graph = Graph.fromSnapshot(payload.graph, {
        maxNodes: payload.config.limits.maxGraphNodes,
        maxEdges: payload.config.limits.maxGraphEdges,
      });
      if (!graph.ok) throw new Error("Worker could not validate the graph snapshot.");
      const ctx: McpContext = {
        root: payload.root,
        config: payload.config,
        state: {
          graph: graph.value,
          index: payload.index,
          contexts: payload.contexts,
          ownership: ownershipIndexFromRecords(payload.ownershipRecords),
          warnings: payload.warnings,
        },
        ...(payload.scopes ? {
          authorization: {
            scopes: new Set(payload.scopes),
            ...(payload.repositoryRoot !== undefined ? { repositoryRoot: payload.repositoryRoot } : {}),
          },
        } : {}),
      };
      parentPort!.postMessage({ ok: true, response: handleMcpLine(ctx, payload.line) });
    } catch (error) {
      parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
