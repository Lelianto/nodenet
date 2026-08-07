/**
 * Resource limits (NodeNet spec §40).
 *
 * NodeNet must protect itself against malicious or pathological
 * repositories: oversized files, dependency bombs, gigantic graphs. Limits
 * are configurable, and violations fail safely (skip with a warning)
 * rather than crashing or consuming unbounded memory.
 */

import { LimitExceededError } from "../types/result.js";

export interface Limits {
  /** Maximum bytes per scanned file. Larger files are skipped with a warning. */
  maxFileSizeBytes: number;
  /** Maximum number of files scanned. */
  maxFiles: number;
  /** Maximum number of AST nodes parsed per file. */
  maxAstNodesPerFile: number;
  /** Maximum number of graph nodes. */
  maxGraphNodes: number;
  /** Maximum number of graph edges. */
  maxGraphEdges: number;
  /** Maximum traversal depth. */
  maxTraversalDepth: number;
  /** Maximum nodes visited during a traversal. */
  maxTraversalNodes: number;
  /** Maximum results returned by a query. */
  maxQueryResults: number;
  /** Maximum characters in generated AI context output. */
  maxContextOutputChars: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFileSizeBytes: 1_048_576, // 1 MiB
  maxFiles: 10_000,
  maxAstNodesPerFile: 200_000,
  maxGraphNodes: 100_000,
  maxGraphEdges: 300_000,
  maxTraversalDepth: 8,
  maxTraversalNodes: 5_000,
  maxQueryResults: 200,
  maxContextOutputChars: 60_000,
};

export function assertFileSize(size: number, max: number, path: string): void {
  if (size > max) {
    throw new LimitExceededError(
      `File exceeds maximum parse size (${size} bytes > ${max} bytes): ${path}. Skipping with warning.`,
    );
  }
}
