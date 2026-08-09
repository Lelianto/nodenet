/** Immutable MCP analysis snapshots with atomic config + state replacement. */
import type { LoadedConfig } from "../config/config.js";
import type { AnalysisState } from "../types/analysis-state.js";

export interface McpSnapshot {
  config: LoadedConfig;
  state: AnalysisState;
  revision: string;
  loadedAt: string;
}

export class McpSnapshotStore {
  #current: McpSnapshot;

  constructor(config: LoadedConfig, state: AnalysisState) {
    this.#current = freezeSnapshot(config, state);
  }

  /** A request retains this exact object even when a later swap occurs. */
  acquire(): McpSnapshot {
    return this.#current;
  }

  /** Validate completely, then replace with one atomic reference assignment. */
  swap(config: LoadedConfig, state: AnalysisState): McpSnapshot {
    const next = freezeSnapshot(config, state);
    this.#current = next;
    return next;
  }
}

function freezeSnapshot(config: LoadedConfig, state: AnalysisState): McpSnapshot {
  if (state.graph.size !== state.graph.metadata.nodeCount && state.graph.metadata.nodeCount !== 0) {
    throw new Error("Snapshot graph node count does not match metadata.");
  }
  if (state.graph.edgeCount !== state.graph.metadata.edgeCount && state.graph.metadata.edgeCount !== 0) {
    throw new Error("Snapshot graph edge count does not match metadata.");
  }
  return Object.freeze({
    config,
    state,
    revision: state.graph.metadata.builtAt,
    loadedAt: new Date().toISOString(),
  });
}
