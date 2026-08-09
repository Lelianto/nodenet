/**
 * Cycle-safe graph traversal (NodeNet spec §41).
 *
 * All traversal enforces a visited set plus configurable maximum depth and
 * maximum node counts. Recursion without limits never happens.
 */

import type { NodeId } from "../types/brand.js";
import type { GraphEdge } from "./edges.js";
import type { Graph } from "./graph.js";
import type { GraphNode } from "./nodes.js";

export interface TraversalLimits {
  maxDepth: number;
  maxNodes: number;
}

export interface TraversalResult {
  visited: Set<NodeId>;
  order: NodeId[];
}

function traverseBfs(
  graph: Graph,
  seeds: readonly NodeId[],
  direction: "out" | "in" | "both",
  limits: TraversalLimits,
  predicate: (edge: GraphEdge) => boolean,
): TraversalResult {
  const visited = new Set<NodeId>();
  const order: NodeId[] = [];
  let frontier: NodeId[] = [];
  for (const seed of seeds) {
    if (!visited.has(seed)) {
      visited.add(seed);
      order.push(seed);
      frontier.push(seed);
    }
  }
  let depth = 0;
  while (frontier.length > 0 && depth < limits.maxDepth) {
    if (visited.size >= limits.maxNodes) break;
    const next: NodeId[] = [];
    for (const id of frontier) {
      const edges =
        direction === "out"
          ? graph.out(id)
          : direction === "in"
            ? graph.into(id)
            : [...graph.out(id), ...graph.into(id)];
      for (const edge of edges) {
        if (!predicate(edge)) continue;
        const target = direction === "in" ? edge.from : direction === "out" ? edge.to : (edge.from === id ? edge.to : edge.from);
        if (!visited.has(target)) {
          if (visited.size >= limits.maxNodes) break;
          visited.add(target);
          order.push(target);
          next.push(target);
        }
      }
    }
    frontier = next;
    depth++;
  }
  return { visited, order };
}

/** Collect every node reachable from the seeds (both directions by default). */
export function collectAffected(
  graph: Graph,
  seeds: readonly NodeId[],
  limits: TraversalLimits,
  predicate: (edge: GraphEdge) => boolean = () => true,
): Set<NodeId> {
  return traverseBfs(graph, seeds, "both", limits, predicate).visited;
}

/** Collect reachable nodes with their shortest unweighted hop distance. */
export function collectAffectedWithDistance(
  graph: Graph,
  seeds: readonly NodeId[],
  limits: TraversalLimits,
  predicate: (edge: GraphEdge) => boolean = () => true,
): Map<NodeId, number> {
  const distances = new Map<NodeId, number>();
  let frontier: NodeId[] = [];
  for (const seed of seeds) { if (!distances.has(seed)) { distances.set(seed, 0); frontier.push(seed); } }
  let depth = 0;
  while (frontier.length > 0 && depth < limits.maxDepth && distances.size < limits.maxNodes) {
    const next: NodeId[] = [];
    for (const id of frontier) {
      for (const edge of graph.incident(id)) {
        if (!predicate(edge)) continue;
        const neighbor = edge.from === id ? edge.to : edge.from;
        if (distances.has(neighbor)) continue;
        distances.set(neighbor, depth + 1); next.push(neighbor);
        if (distances.size >= limits.maxNodes) break;
      }
      if (distances.size >= limits.maxNodes) break;
    }
    frontier = next; depth++;
  }
  return distances;
}

/** Shortest path (by edge count) between two nodes, or null. */
export function findPath(
  graph: Graph,
  from: NodeId,
  to: NodeId,
  limits: TraversalLimits,
  predicate: (edge: GraphEdge) => boolean = () => true,
): GraphEdge[] | null {
  if (from === to) return [];
  interface QueueItem {
    id: NodeId;
    path: GraphEdge[];
  }
  const visited = new Set<NodeId>([from]);
  const queue: QueueItem[] = [{ id: from, path: [] }];
  let head = 0;
  while (head < queue.length && queue.length < limits.maxNodes) {
    const item = queue[head];
    head++;
    if (item === undefined) break;
    const edges = [...graph.out(item.id), ...graph.into(item.id)];
    for (const edge of edges) {
      if (!predicate(edge)) continue;
      const neighbor = edge.from === item.id ? edge.to : edge.from;
      const nextPath = [...item.path, edge];
      if (neighbor === to) return nextPath;
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ id: neighbor, path: nextPath });
      }
      if (queue.length >= limits.maxNodes) break;
    }
  }
  return null;
}

/** Neighbors of a node with the edges connecting them. */
export function neighbors(graph: Graph, id: NodeId): { node: GraphNode; edges: GraphEdge[] }[] {
  const grouped = new Map<NodeId, GraphEdge[]>();
  for (const edge of graph.incident(id)) {
    const other = edge.from === id ? edge.to : edge.from;
    const list = grouped.get(other);
    if (list) list.push(edge);
    else grouped.set(other, [edge]);
  }
  const result: { node: GraphNode; edges: GraphEdge[] }[] = [];
  for (const [nid, edges] of grouped) {
    const node = graph.getNode(nid);
    if (node) result.push({ node, edges });
  }
  return result;
}
