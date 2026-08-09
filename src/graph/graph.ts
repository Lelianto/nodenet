/**
 * Immutable-style Graph with explicit change sets (NodeNet spec §37).
 *
 * The graph exposes read-only maps and immutable snapshots. Mutating
 * operations (`addNode`, `addEdge`) report the exact change they produced
 * as a `GraphPatch`, enabling auditability, testing, rollback and
 * incremental updates.
 */

import type { EdgeId, NodeId } from "../types/brand.js";
import type { Result } from "../types/result.js";
import { ok, err, GraphBuildError, InvalidEdgeError, LimitExceededError } from "../types/result.js";
import type { GraphNode } from "./nodes.js";
import type { GraphEdge } from "./edges.js";
import { assertRelationAllowed } from "./edges.js";

// ---------------------------------------------------------------------------
// Change sets
// ---------------------------------------------------------------------------

export interface GraphPatch {
  addedNodes: GraphNode[];
  removedNodes: GraphNode[];
  updatedNodes: GraphNode[];
  addedEdges: GraphEdge[];
  removedEdges: GraphEdge[];
}

export function emptyPatch(): GraphPatch {
  return { addedNodes: [], removedNodes: [], updatedNodes: [], addedEdges: [], removedEdges: [] };
}

export function mergePatches(patches: GraphPatch[]): GraphPatch {
  const acc = emptyPatch();
  for (const p of patches) {
    acc.addedNodes.push(...p.addedNodes);
    acc.removedNodes.push(...p.removedNodes);
    acc.updatedNodes.push(...p.updatedNodes);
    acc.addedEdges.push(...p.addedEdges);
    acc.removedEdges.push(...p.removedEdges);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Snapshot (serialization boundary)
// ---------------------------------------------------------------------------

export interface GraphMetadata {
  version: 1;
  builtAt: string;
  root: string;
  nodeCount: number;
  edgeCount: number;
}

export interface GraphSnapshot {
  metadata: GraphMetadata;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export interface GraphLimits {
  maxNodes: number;
  maxEdges: number;
}

export class Graph {
  readonly limits: GraphLimits;
  readonly metadata: GraphMetadata;

  private readonly nodeMap = new Map<NodeId, GraphNode>();
  private readonly edgeMap = new Map<EdgeId, GraphEdge>();
  private readonly outEdges = new Map<NodeId, GraphEdge[]>();
  private readonly inEdges = new Map<NodeId, GraphEdge[]>();

  constructor(limits?: Partial<GraphLimits>, metadata?: Partial<GraphMetadata>) {
    this.limits = {
      maxNodes: limits?.maxNodes ?? 100_000,
      maxEdges: limits?.maxEdges ?? 300_000,
    };
    this.metadata = {
      version: 1,
      builtAt: new Date().toISOString(),
      root: metadata?.root ?? ".",
      nodeCount: 0,
      edgeCount: 0,
    };
  }

  // -- read API -------------------------------------------------------------

  get size(): number {
    return this.nodeMap.size;
  }

  get edgeCount(): number {
    return this.edgeMap.size;
  }

  getNode(id: NodeId): GraphNode | undefined {
    return this.nodeMap.get(id);
  }

  hasNode(id: NodeId): boolean {
    return this.nodeMap.has(id);
  }

  getEdge(id: EdgeId): GraphEdge | undefined {
    return this.edgeMap.get(id);
  }

  nodes(): IterableIterator<GraphNode> {
    return this.nodeMap.values();
  }

  edges(): IterableIterator<GraphEdge> {
    return this.edgeMap.values();
  }

  /** Edges leaving a node. */
  out(id: NodeId): readonly GraphEdge[] {
    return this.outEdges.get(id) ?? [];
  }

  /** Edges entering a node. */
  into(id: NodeId): readonly GraphEdge[] {
    return this.inEdges.get(id) ?? [];
  }

  /** Every edge touching a node. */
  incident(id: NodeId): readonly GraphEdge[] {
    return [...this.out(id), ...this.into(id)];
  }

  /** All nodes matching a predicate. */
  findNodes(predicate: (n: GraphNode) => boolean): GraphNode[] {
    const found: GraphNode[] = [];
    for (const node of this.nodeMap.values()) {
      if (predicate(node)) found.push(node);
    }
    return found;
  }

  /** Case-insensitive name search across nodes. */
  queryByName(name: string): GraphNode[] {
    const needle = name.toLowerCase();
    const found: Array<{ node: GraphNode; score: number }> = [];
    for (const node of this.nodeMap.values()) {
      const nodeName = node.name.toLowerCase();
      const path = node.kind === "file" ? node.path.toLowerCase() : "";
      let score = -1;
      if (nodeName === needle) score = node.kind === "file" ? 300 : 500;
      else if (nodeName.startsWith(needle)) score = node.kind === "file" ? 200 : 400;
      else if (nodeName.includes(needle)) score = node.kind === "file" ? 150 : 350;
      else if (path.includes(needle)) score = 100;
      if (score >= 0) found.push({ node, score });
    }
    return found
      .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name) || a.node.id.localeCompare(b.node.id))
      .map(({ node }) => node);
  }

  // -- mutation API ----------------------------------------------------------

  addNode(node: GraphNode): GraphPatch {
    const existing = this.nodeMap.get(node.id);
    const patch = emptyPatch();
    if (existing && existing === node) return patch;
    if (this.nodeMap.size >= this.limits.maxNodes) {
      throw new LimitExceededError(`Graph node limit (${this.limits.maxNodes}) reached.`);
    }
    if (existing) {
      this.nodeMap.set(node.id, node);
      patch.updatedNodes.push(node);
    } else {
      this.nodeMap.set(node.id, node);
      patch.addedNodes.push(node);
    }
    return patch;
  }

  addEdge(edge: GraphEdge): Result<GraphPatch, InvalidEdgeError> {
    const from = this.nodeMap.get(edge.from);
    const to = this.nodeMap.get(edge.to);
    if (!from || !to) {
      return err(new InvalidEdgeError(`Edge references missing node: ${edge.from} -> ${edge.to}`));
    }
    try {
      assertRelationAllowed(edge.relation, from, to);
    } catch (e) {
      return err(e instanceof InvalidEdgeError ? e : new InvalidEdgeError(String(e)));
    }
    if (this.edgeMap.size >= this.limits.maxEdges) {
      return err(new LimitExceededError(`Graph edge limit (${this.limits.maxEdges}) reached.`));
    }
    const patch = emptyPatch();
    if (this.edgeMap.has(edge.id)) {
      // upsert: keep adjacency lists pointing at the freshest object
      this.edgeMap.set(edge.id, edge);
      replaceEdge(this.outEdges, edge.from, edge);
      replaceEdge(this.inEdges, edge.to, edge);
      patch.addedEdges.push(edge);
    } else {
      this.edgeMap.set(edge.id, edge);
      patch.addedEdges.push(edge);
      pushEdge(this.outEdges, edge.from, edge);
      pushEdge(this.inEdges, edge.to, edge);
    }
    return ok(patch);
  }

  /** Add several edges, collecting only the failures. */
  addEdges(edges: GraphEdge[]): Result<GraphEdge[], InvalidEdgeError[]> {
    const failures: InvalidEdgeError[] = [];
    for (const edge of edges) {
      const result = this.addEdge(edge);
      if (!result.ok) failures.push(result.error);
    }
    return failures.length === 0 ? ok([]) : err(failures);
  }

  /** Remove a node and every incident edge. Returns the change set. */
  removeNode(id: NodeId): GraphPatch {
    const patch = emptyPatch();
    const node = this.nodeMap.get(id);
    if (!node) return patch;
    const incident = [...this.out(id), ...this.into(id)];
    for (const edge of incident) {
      this.edgeMap.delete(edge.id);
      patch.removedEdges.push(edge);
      removeEdge(this.outEdges, edge.from, edge.id);
      removeEdge(this.inEdges, edge.to, edge.id);
    }
    this.nodeMap.delete(id);
    patch.removedNodes.push(node);
    return patch;
  }

  // -- snapshot / restore ------------------------------------------------------

  toSnapshot(): GraphSnapshot {
    return {
      metadata: {
        ...this.metadata,
        nodeCount: this.nodeMap.size,
        edgeCount: this.edgeMap.size,
      },
      nodes: [...this.nodeMap.values()],
      edges: [...this.edgeMap.values()],
    };
  }

  /** Build a new Graph from a snapshot, validating every edge. */
  static fromSnapshot(
    snapshot: GraphSnapshot,
    limits?: Partial<GraphLimits>,
  ): Result<Graph, GraphBuildError | InvalidEdgeError[]> {
    const graph = new Graph(limits, snapshot.metadata);
    for (const node of snapshot.nodes) {
      graph.addNode(node);
    }
    const edgeFailures: InvalidEdgeError[] = [];
    for (const edge of snapshot.edges) {
      const result = graph.addEdge(edge);
      if (!result.ok) edgeFailures.push(result.error);
    }
    if (edgeFailures.length > 0) {
      return err(edgeFailures);
    }
    return ok(graph);
  }
}

function pushEdge(map: Map<NodeId, GraphEdge[]>, key: NodeId, edge: GraphEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

function replaceEdge(map: Map<NodeId, GraphEdge[]>, key: NodeId, edge: GraphEdge): void {
  const list = map.get(key);
  if (!list) return;
  const idx = list.findIndex((e) => e.id === edge.id);
  if (idx >= 0) list[idx] = edge;
}

function removeEdge(map: Map<NodeId, GraphEdge[]>, key: NodeId, edgeId: EdgeId): void {
  const list = map.get(key);
  if (!list) return;
  const idx = list.findIndex((e) => e.id === edgeId);
  if (idx >= 0) list.splice(idx, 1);
}
