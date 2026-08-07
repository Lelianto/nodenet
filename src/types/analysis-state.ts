/**
 * Shared analysis state used by programmatic surfaces (GitHub integration,
 * MCP server). Represents a loaded graph + governance layers ready for
 * analysis commands.
 */

import type { Graph } from "../graph/graph.js";
import type { CodeGraphIndex } from "../analyzer/code-graph.js";
import type { ContextRecord } from "../context/schema.js";
import type { OwnershipIndex } from "../ownership/resolver.js";

export interface AnalysisState {
  graph: Graph;
  index: CodeGraphIndex;
  contexts: ContextRecord[];
  ownership: OwnershipIndex;
  warnings: string[];
}
