/**
 * Deterministic graph layout (NodeNet spec §53, Phase 8).
 *
 * Community-hierarchical force layout: communities are laid out as
 * clusters, each cluster internally arranged by a small force simulation,
 * then placed in space by a force simulation over the community graph.
 * This keeps the expensive O(n²) work bounded to per-community sizes while
 * producing readable, non-overlapping clusters. Fully deterministic — no
 * randomness, deterministic iteration order.
 */

import type { Graph } from "../graph/graph.js";
import type { NodeId } from "../types/brand.js";
import type { CommunityId } from "./communities.js";

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  /** Abstract layout width (default 1000). */
  width?: number;
  /** Abstract layout height (default 700). */
  height?: number;
  /** Force iterations per simulation (default 60). */
  iterations?: number;
}

const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 700;

/**
 * Force simulation over `positions` (mutates them). Attraction along edges,
 * pairwise repulsion, fixed iteration count and deterministic ordering.
 */
function simulate(
  positions: Point[],
  edges: [number, number][],
  iterations: number,
  width: number,
  height: number,
): void {
  const n = positions.length;
  if (n === 0) return;
  const cx = width / 2;
  const cy = height / 2;
  if (n === 1) {
    const only = positions[0]!;
    only.x = cx;
    only.y = cy;
    return;
  }
  const radius = Math.max(width, height) * 0.34;
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    const p = positions[i]!;
    p.x = cx + radius * Math.cos(angle);
    p.y = cy + radius * Math.sin(angle);
  }

  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    adj[a]!.push(b);
    adj[b]!.push(a);
  }

  const ideal = Math.sqrt((width * height) / Math.max(n, 1));
  const ideal2 = ideal * ideal;

  for (let iter = 0; iter < iterations; iter++) {
    const cooling = Math.max(0.1, (iterations - iter) / iterations);

    // Repulsion (all pairs).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = positions[i]!;
        const b = positions[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) dist2 = 0.01;
        const dist = Math.sqrt(dist2);
        const force = (ideal2 / dist) * 0.5 * cooling;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.x += fx;
        a.y += fy;
        b.x -= fx;
        b.y -= fy;
      }
    }

    // Attraction (edges).
    for (let a = 0; a < n; a++) {
      const adjA = adj[a]!;
      for (const b of adjA) {
        if (b <= a) continue;
        const pa = positions[a]!;
        const pb = positions[b]!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) dist = 0.01;
        const force = ((dist - ideal) / dist) * 0.12 * cooling;
        pa.x -= dx * force;
        pa.y -= dy * force;
        pb.x += dx * force;
        pb.y += dy * force;
      }
    }

    for (const p of positions) {
      p.x = Math.min(width, Math.max(0, p.x));
      p.y = Math.min(height, Math.max(0, p.y));
    }
  }
}

/** Produce a [0..width]x[0..height] position for every node. */
export function layoutGraph(
  graph: Graph,
  communities: Map<NodeId, CommunityId>,
  opts: LayoutOptions = {},
): Map<NodeId, Point> {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const iterations = opts.iterations ?? 60;

  const nodes = [...graph.nodes()];
  const idToIndex = new Map<NodeId, number>();
  nodes.forEach((n, i) => idToIndex.set(n.id, i));

  // Group node indices by community.
  const byCommunity = new Map<CommunityId, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const c = communities.get(nodes[i]!.id) ?? 0;
    const list = byCommunity.get(c);
    if (list) list.push(i);
    else byCommunity.set(c, [i]);
  }

  // 1. Local layout within each community.
  const local = new Map<number, Point>();
  const LOCAL_BOX = 1000;
  for (const [c, members] of byCommunity) {
    const positions: Point[] = members.map(() => ({ x: 0, y: 0 }));
    const memberIndex = new Map<number, number>();
    members.forEach((idx, pos) => memberIndex.set(idx, pos));
    const edges: [number, number][] = [];
    for (const edge of graph.edges()) {
      const a = memberIndex.get(idToIndex.get(edge.from) ?? -1);
      const b = memberIndex.get(idToIndex.get(edge.to) ?? -1);
      if (a === undefined || b === undefined || a === b) continue;
      edges.push([a, b]);
    }
    simulate(positions, edges, iterations, LOCAL_BOX, LOCAL_BOX);

    const m = members.length;
    let cx = 0;
    let cy = 0;
    for (const p of positions) {
      cx += p.x;
      cy += p.y;
    }
    cx /= m;
    cy /= m;
    let maxR = 1;
    for (const p of positions) {
      const r = Math.hypot(p.x - cx, p.y - cy);
      if (r > maxR) maxR = r;
    }
    const targetRadius = Math.max(60, 130 * Math.sqrt(m));
    const scale = targetRadius / maxR;
    members.forEach((idx, pos) => {
      const p = positions[pos]!;
      local.set(idx, { x: (p.x - cx) * scale, y: (p.y - cy) * scale });
    });
    void c;
  }

  // 2. Community graph (pairwise edge counts become parallel edges).
  const communityIds = [...byCommunity.keys()];
  const cIndex = new Map<CommunityId, number>();
  communityIds.forEach((c, i) => cIndex.set(c, i));
  const cEdges: [number, number][] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges()) {
    const a = cIndex.get(communities.get(edge.from) ?? 0);
    const b = cIndex.get(communities.get(edge.to) ?? 0);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cEdges.push([a, b]);
  }

  // 3. Layout community centers, then compose.
  const centers: Point[] = communityIds.map(() => ({ x: 0, y: 0 }));
  simulate(centers, cEdges, iterations, width, height);

  const result = new Map<NodeId, Point>();
  communityIds.forEach((c, ci) => {
    const center = centers[ci]!;
    for (const idx of byCommunity.get(c) ?? []) {
      const l = local.get(idx) ?? { x: 0, y: 0 };
      const x = Math.min(width, Math.max(0, center.x + l.x));
      const y = Math.min(height, Math.max(0, center.y + l.y));
      result.set(nodes[idx]!.id, { x, y });
    }
  });
  return result;
}
