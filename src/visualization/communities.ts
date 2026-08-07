/**
 * Community detection (NodeNet spec §53, Phase 8).
 *
 * Deterministic label propagation over the undirected graph, ignoring
 * `contains` containment edges so communities reflect real coupling, not
 * directory nesting. Label choice is tie-broken by the smallest label so the
 * result is reproducible for a given graph build order. Used to color and
 * cluster the interactive visualization.
 */

import type { Graph } from "../graph/graph.js";
import type { NodeId } from "../types/brand.js";

export type CommunityId = number;

/** Map every node to a compact community id (0..k-1). */
export function detectCommunities(graph: Graph): Map<NodeId, CommunityId> {
  const ids: NodeId[] = [...graph.nodes()].map((n) => n.id);

  const neighbors = new Map<NodeId, NodeId[]>();
  for (const id of ids) neighbors.set(id, []);

  for (const edge of graph.edges()) {
    if (edge.relation === "contains") continue;
    neighbors.get(edge.from)?.push(edge.to);
    neighbors.get(edge.to)?.push(edge.from);
  }

  // Initial: every node is its own community.
  const labels = new Map<NodeId, number>();
  ids.forEach((id, i) => labels.set(id, i));

  const MAX_ITERATIONS = 12;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    for (const id of ids) {
      const nbrs = neighbors.get(id) ?? [];
      if (nbrs.length === 0) continue;
      const counts = new Map<number, number>();
      for (const n of nbrs) {
        const label = labels.get(n) ?? 0;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      let best = -1;
      let bestCount = -1;
      for (const [label, count] of counts) {
        if (count > bestCount || (count === bestCount && (best === -1 || label < best))) {
          best = label;
          bestCount = count;
        }
      }
      if (best !== -1 && labels.get(id) !== best) {
        labels.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Compact labels to 0..k-1 in order of first appearance (stable).
  const renumber = new Map<number, CommunityId>();
  let next = 0;
  const result = new Map<NodeId, CommunityId>();
  for (const id of ids) {
    const raw = labels.get(id) ?? 0;
    let compact = renumber.get(raw);
    if (compact === undefined) {
      compact = next;
      renumber.set(raw, next);
      next++;
    }
    result.set(id, compact);
  }
  return result;
}
