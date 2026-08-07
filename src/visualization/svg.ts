/**
 * Static SVG graph export (NodeNet spec §53).
 *
 * Renders the same deterministic community layout as the interactive HTML
 * viewer as a standalone SVG image: community hulls, color-coded layer nodes,
 * typed edges, and labels. Useful for embedding in docs/PRs.
 */

import type { Graph } from "../graph/graph.js";
import type { GraphNode } from "../graph/nodes.js";
import type { NodeId } from "../types/brand.js";
import type { AuthorityLevel } from "../authority/authority.js";
import { detectCommunities } from "./communities.js";
import { layoutGraph } from "./layout.js";

export interface SvgOptions {
  width?: number;
  height?: number;
  iterations?: number;
  /** When true, draw every node's label (default true up to 200 nodes). */
  showLabels?: boolean;
}

const CODE_LAYER = new Set([
  "repository", "workspace", "package", "directory", "file", "function", "method",
  "class", "interface", "typeAlias", "enum", "variable", "reactComponent",
  "reactHook", "apiRoute", "middleware", "test", "configuration",
]);
const ACTOR_LAYER = new Set(["developer", "team", "role"]);
const CONTEXT_LAYER = new Set([
  "businessRule", "architectureDecision", "securityPolicy", "codingConvention",
  "requirement", "specification", "complianceRule", "operationalRule",
  "incidentLearning", "assumption", "domainRule", "externalConstraint",
]);

const LAYER_COLORS: Record<string, string> = {
  code: "#3b82f6",
  ctx: "#a855f7",
  own: "#22c55e",
  auth: "#f59e0b",
};

const GOVERNANCE_EDGES = new Set(["governed_by", "applies_to", "conflicts_with", "supersedes", "constrained_by", "implements_context", "validated_by"]);
const OWNERSHIP_EDGES = new Set(["owned_by", "approved_by", "reviews", "member_of", "responsible_for", "maintains"]);

function layerOf(node: GraphNode): string {
  if (CODE_LAYER.has(node.kind)) return "code";
  if (ACTOR_LAYER.has(node.kind)) return "own";
  if (CONTEXT_LAYER.has(node.kind)) {
    const authority = (node as { authority?: AuthorityLevel }).authority;
    return authority === "HARDENED" || authority === "MANDATORY" ? "auth" : "ctx";
  }
  return "code";
}

function shortLabel(node: GraphNode): string {
  switch (node.kind) {
    case "file":
      return node.path;
    case "function":
    case "method":
      return `${node.name}()`;
    case "repository":
      return `repo:${node.name}`;
    default:
      return node.name;
  }
}

function hullColor(comm: number): string {
  return `hsl(${(comm * 47) % 360} 65% 55%)`;
}

export function renderGraphSvg(graph: Graph, options: SvgOptions = {}): string {
  const width = options.width ?? 1000;
  const height = options.height ?? 700;
  const iterations = options.iterations ?? 60;
  const showLabels = options.showLabels ?? graph.size <= 200;

  const communities = detectCommunities(graph);
  const positions = layoutGraph(graph, communities, { width, height, iterations });

  const nodes: GraphNode[] = [...graph.nodes()];
  const idToIndex = new Map<NodeId, number>();
  nodes.forEach((n, i) => idToIndex.set(n.id, i));

  const degree = new Map<NodeId, number>();
  for (const edge of graph.edges()) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const byComm = new Map<number, { x: number; y: number }[]>();
  for (const n of nodes) {
    const c = communities.get(n.id) ?? 0;
    const list = byComm.get(c);
    if (list) list.push(positions.get(n.id)!);
    else byComm.set(c, [positions.get(n.id)!]);
  }

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);

  // Community hulls
  for (const [c, points] of byComm) {
    let cx = 0;
    let cy = 0;
    for (const p of points) {
      cx += p.x;
      cy += p.y;
    }
    cx /= points.length;
    cy /= points.length;
    let r = 12;
    for (const p of points) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
    r += 22;
    const col = hullColor(c);
    parts.push(`<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}" fill="${col}1A" stroke="${col}44" stroke-width="1"/>`);
  }

  // Edges
  for (const edge of graph.edges()) {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) continue;
    const stroke = GOVERNANCE_EDGES.has(edge.relation) ? "#a855f7" : OWNERSHIP_EDGES.has(edge.relation) ? "#16a34a" : "#cbd5e1";
    parts.push(`<line x1="${round(a.x)}" y1="${round(a.y)}" x2="${round(b.x)}" y2="${round(b.y)}" stroke="${stroke}" stroke-width="1"/>`);
  }

  // Nodes
  for (const n of nodes) {
    const pos = positions.get(n.id);
    if (!pos) continue;
    const layer = layerOf(n);
    const r = Math.min(11, Math.max(3.5, 3.5 + Math.sqrt((degree.get(n.id) ?? 0) + 1) * 1.5));
    const fill = LAYER_COLORS[layer];
    parts.push(`<circle cx="${round(pos.x)}" cy="${round(pos.y)}" r="${round(r)}" fill="${fill}" stroke="#ffffff" stroke-width="1"/>`);
    if (showLabels) {
      const label = shortLabel(n);
      parts.push(
        `<text x="${round(pos.x)}" y="${round(pos.y - r - 3)}" text-anchor="middle" font-size="9" fill="#475569">${escapeXml(label)}</text>`,
      );
    }
  }

  // Legend
  const legendY = height - 16;
  let lx = 16;
  for (const [layer, label] of Object.entries({ code: "Code", ctx: "Context", own: "Ownership", auth: "Authority" })) {
    parts.push(`<circle cx="${lx + 5}" cy="${legendY}" r="5" fill="${LAYER_COLORS[layer]}"/>`);
    parts.push(`<text x="${lx + 16}" y="${legendY + 3}" font-size="10" fill="#475569">${label}</text>`);
    lx += 16 + label.length * 6 + 12;
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
