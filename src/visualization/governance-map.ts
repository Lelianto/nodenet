/**
 * Governance-first, self-contained interactive graph renderer.
 * Community controls color, semantic layer controls shape, degree controls
 * size, and governance state controls rings and edge emphasis.
 */

import type { Graph } from "../graph/graph.js";
import { nodeLabel, type ContextNode, type GraphNode } from "../graph/nodes.js";
import type { NodeId } from "../types/brand.js";
import type { GovernanceDecision } from "../governance/decision.js";
import { evidenceClassForSource } from "../graph/edges.js";
import { detectCommunities } from "./communities.js";
import { layoutGraph } from "./layout.js";

export interface GovernanceMapOptions {
  title?: string;
  width?: number;
  height?: number;
  iterations?: number;
  change?: {
    decision: GovernanceDecision;
    changedNodeIds: NodeId[];
    affectedNodeIds: NodeId[];
  };
}

const ACTOR_KINDS = new Set(["developer", "team", "role"]);
const CONTEXT_KINDS = new Set([
  "businessRule", "architectureDecision", "securityPolicy", "codingConvention",
  "requirement", "specification", "complianceRule", "operationalRule",
  "incidentLearning", "assumption", "domainRule", "externalConstraint",
]);
const CONTAINER_KINDS = new Set(["repository", "workspace", "package", "directory"]);
const FILE_KINDS = new Set(["file", "configuration", "test"]);
const CHANGE_RELATIONS = new Set(["affects", "modifies"]);
const GOVERNANCE_RELATIONS = new Set([
  "governed_by", "constrained_by", "implements_context", "validated_by",
  "supersedes", "conflicts_with", "derived_from", "applies_to",
]);
const OWNERSHIP_RELATIONS = new Set([
  "owned_by", "approved_by", "maintains", "reviews", "member_of", "responsible_for",
]);

function layer(node: GraphNode): "code" | "context" | "actor" | "change" {
  if (ACTOR_KINDS.has(node.kind)) return "actor";
  if (CONTEXT_KINDS.has(node.kind)) return "context";
  return "code";
}

function shape(node: GraphNode): "circle" | "square" | "hexagon" | "diamond" | "pill" | "triangle" {
  if (CONTEXT_KINDS.has(node.kind)) return "diamond";
  if (ACTOR_KINDS.has(node.kind)) return "pill";
  if (CONTAINER_KINDS.has(node.kind)) return "hexagon";
  if (FILE_KINDS.has(node.kind)) return "square";
  return "circle";
}

function shortLabel(node: GraphNode): string {
  if (node.kind === "file") return node.path.split("/").pop() ?? node.path;
  if (node.kind === "function" || node.kind === "method") return `${node.name}()`;
  return node.name;
}

function displayGroupKey(node: GraphNode): string {
  const record = node as unknown as Record<string, unknown>;
  const candidate = typeof record["path"] === "string" ? record["path"] : typeof record["file"] === "string" ? record["file"] : "";
  if (candidate) {
    const parts = candidate.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] ?? "root";
  }
  if (node.kind === "team" || node.kind === "role" || node.kind === "developer") return "governance/actors";
  if (CONTEXT_KINDS.has(node.kind)) return "governance/contexts";
  return `kind/${node.kind}`;
}

function communityName(members: GraphNode[], degreeById: Map<NodeId, number>): string {
  const ranked = [...members].sort((a, b) => {
    const aContainer = CONTAINER_KINDS.has(a.kind) ? 0 : 1;
    const bContainer = CONTAINER_KINDS.has(b.kind) ? 0 : 1;
    return aContainer - bContainer || (degreeById.get(b.id) ?? 0) - (degreeById.get(a.id) ?? 0) || a.name.localeCompare(b.name);
  });
  const preferred = ranked.find((node) => !["root", "src", "repository"].includes(node.name.toLowerCase()));
  return preferred?.name ?? ranked[0]?.name ?? "Community";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderGovernanceMap(graph: Graph, options: GovernanceMapOptions = {}): string {
  const title = options.title ?? "NodeNet Governance Map";
  const width = options.width ?? 1200;
  const height = options.height ?? 800;
  const communities = detectCommunities(graph);
  // Community detection intentionally ignores containment. For display,
  // fold singleton files/containers into the dominant community they contain
  // so the legend describes domains instead of listing filesystem scaffolding.
  for (let pass = 0; pass < 4; pass++) {
    const counts = new Map<number, number>();
    for (const node of graph.nodes()) {
      const id = communities.get(node.id) ?? 0;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const node of graph.nodes()) {
      const current = communities.get(node.id) ?? 0;
      if ((counts.get(current) ?? 0) > 1 || (!CONTAINER_KINDS.has(node.kind) && !FILE_KINDS.has(node.kind))) continue;
      const candidates = new Map<number, number>();
      for (const edge of graph.out(node.id)) {
        if (edge.relation !== "contains") continue;
        const candidate = communities.get(edge.to);
        if (candidate !== undefined && candidate !== current) candidates.set(candidate, (candidates.get(candidate) ?? 0) + 1);
      }
      const winner = [...candidates].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
      if (winner !== undefined) communities.set(node.id, winner);
    }
  }
  // Collapse tiny algorithmic fragments into a stable path/domain cluster.
  // This prevents hundreds of singleton communities forming a rectangular or
  // circular fence around the useful graph while preserving their nodes.
  const displayCounts = new Map<number, number>();
  for (const node of graph.nodes()) {
    const community = communities.get(node.id) ?? 0;
    displayCounts.set(community, (displayCounts.get(community) ?? 0) + 1);
  }
  const keyCandidates = new Map<string, Map<number, number>>();
  for (const node of graph.nodes()) {
    const key = displayGroupKey(node);
    const community = communities.get(node.id) ?? 0;
    const candidates = keyCandidates.get(key) ?? new Map<number, number>();
    candidates.set(community, (candidates.get(community) ?? 0) + 1);
    keyCandidates.set(key, candidates);
  }
  for (const node of graph.nodes()) {
    const current = communities.get(node.id) ?? 0;
    if ((displayCounts.get(current) ?? 0) > 2) continue;
    const winner = [...(keyCandidates.get(displayGroupKey(node)) ?? new Map()).entries()]
      .sort((a, b) => (displayCounts.get(b[0]) ?? 0) - (displayCounts.get(a[0]) ?? 0) || b[1] - a[1] || a[0] - b[0])[0]?.[0];
    if (winner !== undefined) communities.set(node.id, winner);
  }
  const positions = layoutGraph(graph, communities, {
    width,
    height,
    iterations: options.iterations ?? 60,
  });
  const graphNodes = [...graph.nodes()];
  const positioned = graphNodes.map((node) => positions.get(node.id) ?? { x: width / 2, y: height / 2 });
  const index = new Map<NodeId, number>();
  graphNodes.forEach((node, i) => index.set(node.id, i));
  const degree = graphNodes.map(() => 0);
  const edges: Array<{ s: number; t: number; rel: string; group: string; source: string; evidence: string; location?: string }> = [];
  for (const edge of graph.edges()) {
    const s = index.get(edge.from);
    const t = index.get(edge.to);
    if (s === undefined || t === undefined) continue;
    degree[s] = (degree[s] ?? 0) + 1;
    degree[t] = (degree[t] ?? 0) + 1;
    const group = CHANGE_RELATIONS.has(edge.relation) ? "change" :
      GOVERNANCE_RELATIONS.has(edge.relation) ? "governance" :
      OWNERSHIP_RELATIONS.has(edge.relation) ? "ownership" : "code";
    edges.push({
      s,
      t,
      rel: edge.relation,
      group,
      source: edge.provenance.source,
      evidence: edge.provenance.classification ?? evidenceClassForSource(edge.provenance.source),
      ...(edge.provenance.location !== undefined ? { location: edge.provenance.location } : {}),
    });
  }

  const grouped = new Map<number, GraphNode[]>();
  for (const node of graphNodes) {
    const community = communities.get(node.id) ?? 0;
    const members = grouped.get(community);
    if (members) members.push(node);
    else grouped.set(community, [node]);
  }
  const communityData = [...grouped.entries()].map(([id, members]) => ({
    id,
    name: communityName(members, new Map(graphNodes.map((node, i) => [node.id, degree[i] ?? 0]))),
    count: members.length,
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // Fill an organic ellipsoid volume rather than a hollow spherical shell.
  // Communities keep nearby anchors, while deterministic candidate sampling
  // enforces a minimum 3D distance between every node.
  // Keep dense repositories legible: the 3D world grows with sqrt(n), while
  // semantic islands receive their own adaptive extent below.
  const sphereRadius = Math.max(420, 260 + Math.sqrt(graphNodes.length) * 21);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const volumePositions = new Map<NodeId, { x: number; y: number; z: number }>();
  const placed: Array<{ x: number; y: number; z: number }> = [];
  function stableNodeHash(node: GraphNode): number {
    let hash = 2166136261;
    for (const char of String(node.id)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return hash >>> 0;
  }
  function semanticVolume(node: GraphNode): "runtime" | "structure" | "quality" | "governance" | "ownership" {
    if (ACTOR_KINDS.has(node.kind)) return "ownership";
    if (CONTEXT_KINDS.has(node.kind)) return "governance";
    if (node.kind === "test" || node.kind === "configuration") return "quality";
    if (CONTAINER_KINDS.has(node.kind) || node.kind === "file") return "structure";
    return "runtime";
  }
  const semanticOrder = ["runtime", "structure", "quality", "governance", "ownership"] as const;
  const semanticNodes = new Map<string, GraphNode[]>();
  const volumeGroupByNode = new Map<NodeId, string>();
  for (const node of graphNodes) {
    const group = semanticVolume(node);
    volumeGroupByNode.set(node.id, group);
    const members = semanticNodes.get(group) ?? [];
    members.push(node);
    semanticNodes.set(group, members);
  }
  const ringGroups = semanticOrder.filter((group) => group !== "runtime" && (semanticNodes.get(group)?.length ?? 0) > 0);
  const groupAnchors = new Map<string, { x: number; y: number; z: number }>();
  groupAnchors.set("runtime", { x: 0, y: 0, z: 0 });
  ringGroups.forEach((group, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.max(1, ringGroups.length);
    const anchorRadius = sphereRadius * 0.66;
    groupAnchors.set(group, {
      x: Math.cos(angle) * anchorRadius,
      y: Math.sin(angle) * anchorRadius,
      z: (index % 2 === 0 ? -1 : 1) * sphereRadius * 0.06,
    });
  });
  for (const group of semanticOrder) {
    const members = [...(semanticNodes.get(group) ?? [])].sort((a, b) => stableNodeHash(a) - stableNodeHash(b) || String(a.id).localeCompare(String(b.id)));
    const anchor = groupAnchors.get(group) ?? { x: 0, y: 0, z: 0 };
    const groupExtent = Math.min(sphereRadius * 0.42, 52 + Math.sqrt(Math.max(1, members.length)) * 18);
    members.forEach((node, rank) => {
      let best = { ...anchor };
      let bestDistance = -1;
      const attempts = rank === 0 ? 1 : 32;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const sequence = rank + attempt * members.length + semanticOrder.indexOf(group) * 97 + 1;
        const directionY = 1 - 2 * ((sequence * 0.7548776662466927) % 1);
        const directionRadius = Math.sqrt(Math.max(0, 1 - directionY * directionY));
        const directionAngle = Math.PI * 2 * ((sequence * 0.5698402909980532) % 1);
        const spread = rank === 0 ? 0 : groupExtent * Math.cbrt(rank / Math.max(1, members.length - 1));
        const irregularity = 0.94 + 0.1 * ((sequence * goldenAngle) % 1);
        const candidate = {
          x: anchor.x + Math.cos(directionAngle) * directionRadius * spread * 1.04 * irregularity,
          y: anchor.y + directionY * spread * 0.97 * irregularity,
          z: anchor.z + Math.sin(directionAngle) * directionRadius * spread * 0.92 * irregularity,
        };
        let nearest = Number.POSITIVE_INFINITY;
        for (const previous of placed) nearest = Math.min(nearest, Math.hypot(candidate.x - previous.x, candidate.y - previous.y, candidate.z - previous.z));
        if (nearest > bestDistance) { best = candidate; bestDistance = nearest; }
        if (nearest >= 34) break;
      }
      placed.push(best);
      volumePositions.set(node.id, best);
    });
  }
  // Rotate around the geometric center of the complete composition, not the
  // node-weighted centroid (which is dominated by the large Runtime island).
  const volumeList = [...volumePositions.values()];
  const minVolumeX = volumeList.length ? Math.min(...volumeList.map((position) => position.x)) : 0;
  const maxVolumeX = volumeList.length ? Math.max(...volumeList.map((position) => position.x)) : 0;
  const minVolumeY = volumeList.length ? Math.min(...volumeList.map((position) => position.y)) : 0;
  const maxVolumeY = volumeList.length ? Math.max(...volumeList.map((position) => position.y)) : 0;
  const minVolumeZ = volumeList.length ? Math.min(...volumeList.map((position) => position.z)) : 0;
  const maxVolumeZ = volumeList.length ? Math.max(...volumeList.map((position) => position.z)) : 0;
  const pivotX = (minVolumeX + maxVolumeX) / 2;
  const pivotY = (minVolumeY + maxVolumeY) / 2;
  const pivotZ = (minVolumeZ + maxVolumeZ) / 2;
  for (const position of volumePositions.values()) {
    position.x -= pivotX;
    position.y -= pivotY;
    position.z -= pivotZ;
  }

  const nodes = graphNodes.map((node, i) => {
    const position = positioned[i] ?? { x: 0, y: 0 };
    const context = CONTEXT_KINDS.has(node.kind) ? node as ContextNode : undefined;
    const nodeLayer = layer(node);
    const community = communities.get(node.id) ?? 0;
    const volume = volumePositions.get(node.id) ?? { x: 0, y: 0, z: 0 };
    return {
      i,
      id: node.id,
      label: shortLabel(node),
      full: nodeLabel(node),
      kind: node.kind,
      layer: nodeLayer,
      shape: shape(node),
      community,
      volumeGroup: volumeGroupByNode.get(node.id) ?? "runtime",
      degree: degree[i] ?? 0,
      x: position.x,
      y: position.y,
      gx: volume.x,
      gy: volume.y,
      gz: volume.z,
      changed: options.change?.changedNodeIds.includes(node.id) ?? false,
      affected: options.change?.affectedNodeIds.includes(node.id) ?? false,
      ...(nodeLayer === "context" ? {
        status: context?.status,
        authority: context?.authority,
        classification: context?.governanceClassification,
        approvalRequired: context?.approvalRequired ?? false,
        enforcement: context?.enforcementMode ?? (
          context?.authority === "HARDENED" || context?.authority === "MANDATORY" ? "block" : "warn"
        ),
        sourceFormat: context?.sourceFormat,
      } : {}),
    };
  });
  const islandNames: Record<string, string> = {
    runtime: "Runtime Code",
    structure: "Structure",
    quality: "Tests & Configuration",
    governance: "Governance Context",
    ownership: "Ownership",
  };
  const islands = semanticOrder.map((id) => {
    const members = nodes.filter((node) => node.volumeGroup === id);
    return {
      id,
      name: islandNames[id] ?? id,
      count: members.length,
      gx: members.length ? members.reduce((sum, node) => sum + node.gx, 0) / members.length : 0,
      gy: members.length ? members.reduce((sum, node) => sum + node.gy, 0) / members.length : 0,
      gz: members.length ? members.reduce((sum, node) => sum + node.gz, 0) / members.length : 0,
      x: members.length ? members.reduce((sum, node) => sum + node.x, 0) / members.length : 0,
      y: members.length ? members.reduce((sum, node) => sum + node.y, 0) / members.length : 0,
    };
  }).filter((island) => island.count > 0);
  const payload = JSON.stringify({
    width,
    height,
    sphereRadius,
    nodes,
    edges,
    communities: communityData,
    islands,
    decision: options.change?.decision,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;--bg:#070b14;--panel:#0d1320e8;--panel2:#111a2a;--line:#253047;--text:#e8edf7;--muted:#8491a8;--accent:#7dd3fc;--danger:#fb7185;--warn:#fbbf24;--ok:#34d399}*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden}body{font:13px Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text)}button,input{font:inherit}.app{display:grid;grid-template-rows:52px 1fr 30px;height:100vh}.top{display:flex;align-items:center;gap:18px;padding:0 16px;border-bottom:1px solid var(--line);background:#0a101c}.brand{font-weight:700;letter-spacing:.01em;white-space:nowrap}.brand span{color:var(--accent)}.modes{display:flex;gap:4px;background:#080d17;border:1px solid var(--line);padding:3px;border-radius:9px}.mode{border:0;background:transparent;color:var(--muted);padding:6px 12px;border-radius:6px;cursor:pointer}.mode.active{background:#1a263a;color:#fff}.fit{border:1px solid var(--line);background:#111a2a;color:#cbd5e1;padding:6px 10px;border-radius:7px;cursor:pointer}.top-stats{margin-left:auto;color:var(--muted);font-size:12px}.main{position:relative;min-height:0;overflow:hidden}.canvas-wrap{position:absolute;inset:0;background:radial-gradient(circle at 50% 45%,#101a2a 0,#070b14 64%)}.sidebar,.inspector{position:absolute;top:14px;bottom:14px;z-index:2;background:var(--panel);border:1px solid var(--line);border-radius:13px;box-shadow:0 16px 50px #0008;backdrop-filter:blur(12px);overflow:auto}.sidebar{left:14px;width:230px;padding:14px}.inspector{right:14px;width:290px;padding:15px}.section{margin-bottom:20px}.section-title{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#73819a;margin:0 0 9px}.search{width:100%;background:#080d17;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 10px;outline:none}.search:focus{border-color:#46759b}.community,.filter{display:flex;align-items:center;gap:8px;padding:6px 3px;color:#c8d1e1;cursor:pointer}.community input,.filter input{accent-color:#60a5fa}.swatch{width:7px;height:7px;border-radius:50%;flex:none}.count{margin-left:auto;color:#65728a;font-size:11px}canvas{width:100%;height:100%;display:block;touch-action:none}.canvas-hint{position:absolute;left:260px;bottom:12px;color:#536078;font-size:11px;pointer-events:none}.legend{position:absolute;right:320px;bottom:12px;display:flex;gap:12px;color:#6f7d94;font-size:11px}.legend b{font-weight:500;color:#aab5c7}.empty{color:#68758c;line-height:1.55}.node-title{font-size:16px;font-weight:650;line-height:1.3;margin-bottom:5px;word-break:break-word}.badges{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0 15px}.badge{padding:3px 7px;border:1px solid #33415a;border-radius:999px;color:#b9c5d1;font-size:10px;text-transform:uppercase}.badge.block{border-color:#7f1d36;color:#fda4af;background:#3f0b19}.kv{display:grid;grid-template-columns:92px 1fr;gap:7px 10px;padding:10px 0;border-top:1px solid #1b2638}.key{color:#6f7d94}.value{color:#d4dceb;word-break:break-word}.edge-list{border-top:1px solid #1b2638}.edge-item{padding:9px 0;border-bottom:1px solid #182233;cursor:pointer}.edge-item:hover{color:#fff}.edge-rel{font-size:10px;text-transform:uppercase;color:#7dd3fc}.edge-target{margin-top:3px}.edge-source{font-size:10px;color:#65728a;margin-top:2px}.status{display:flex;align-items:center;padding:0 14px;border-top:1px solid var(--line);background:#080d17;color:#65728a;font-size:11px}.status .decision{margin-left:auto;color:#8a97ac}.status .decision.block{color:#fb7185}.mini-shape{display:inline-block;width:7px;height:7px;background:#8290a7}.mini-shape.context{transform:rotate(45deg)}.mini-shape.actor{width:10px;border-radius:5px}.isolate{margin-top:10px;width:100%;border:1px solid #33415a;background:#131e30;color:#cbd5e1;border-radius:7px;padding:7px;cursor:pointer}.isolate:hover{background:#1a2940}@media(max-width:900px){.inspector{display:none}.legend{right:14px}}@media(max-width:650px){.sidebar{display:none}.canvas-hint{left:14px}.legend{display:none}.top-stats{display:none}}
.camera-pad{position:absolute;left:260px;top:14px;z-index:3;display:grid;grid-template-columns:34px 34px 34px;grid-template-rows:34px 34px 34px;gap:3px;padding:7px;border:1px solid var(--line);border-radius:12px;background:#0d1320cc;box-shadow:0 8px 30px #0007;backdrop-filter:blur(10px)}.camera-pad button{display:grid;place-items:center;border:1px solid #33415a;border-radius:7px;background:#131e30;color:#cbd5e1;cursor:pointer;user-select:none;touch-action:none}.camera-pad button:hover,.camera-pad button:active{color:#fff;background:#243654;border-color:#52719a}.camera-pad .up{grid-column:2}.camera-pad .left{grid-column:1;grid-row:2}.camera-pad .reset{grid-column:2;grid-row:2}.camera-pad .right{grid-column:3;grid-row:2}.camera-pad .down{grid-column:2;grid-row:3}@media(max-width:650px){.camera-pad{left:14px;top:64px}}
.top{gap:8px}.toolbar-group{display:flex;gap:3px;align-items:center;padding:3px;border:1px solid var(--line);border-radius:9px;background:#080d17}.toolbar-group .fit{border:0;background:transparent;min-height:36px}.fit[aria-pressed="true"],.fit.active{background:#1a263a;color:#fff}.control{width:100%;min-height:40px;border:1px solid var(--line);border-radius:8px;background:#080d17;color:var(--text);padding:7px}.search-wrap{position:relative}.search-results{position:absolute;z-index:8;left:0;right:0;top:44px;max-height:260px;overflow:auto;background:#0b1220;border:1px solid var(--line);border-radius:9px;box-shadow:0 14px 35px #000a}.search-results:empty{display:none}.result{padding:9px 10px;border-bottom:1px solid #1b2638;cursor:pointer}.result.active,.result:hover{background:#1a2940}.result small{display:block;color:var(--muted);margin-top:2px}.island{width:100%;display:flex;align-items:center;gap:8px;min-height:40px;border:0;border-radius:7px;background:transparent;color:#c8d1e1;text-align:left;cursor:pointer;padding:6px}.island:hover,.island.active{background:#18263b;color:#fff}.island-dot{width:8px;height:8px;border:2px solid #94a3b8;border-radius:50%}.range-row{display:grid;grid-template-columns:72px 1fr 34px;align-items:center;gap:7px;color:#aab5c7;margin:8px 0}.scope{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.scope button{min-height:40px;border:1px solid var(--line);background:#0b1220;color:var(--muted);border-radius:7px;cursor:pointer}.scope button.active{background:#1d3552;color:#fff;border-color:#46759b}.minimap{position:absolute;right:320px;top:14px;width:180px;height:120px;z-index:3;border:1px solid var(--line);border-radius:10px;background:#070b14dc;cursor:crosshair}.tooltip{position:absolute;z-index:7;max-width:240px;padding:10px 12px;background:#0b1220f2;border:1px solid #33415a;border-radius:9px;box-shadow:0 10px 30px #000b;pointer-events:none;line-height:1.45}.tooltip strong{display:block;color:#fff;margin-bottom:3px}.tooltip[hidden]{display:none}.help{position:absolute;left:260px;bottom:42px;z-index:5;width:230px;padding:12px;background:#0d1320f2;border:1px solid var(--line);border-radius:10px;color:#aab5c7;line-height:1.65;box-shadow:0 12px 30px #0008}.help button{float:right;border:0;background:transparent;color:#94a3b8;cursor:pointer}.help-action{margin-left:auto;border:0;background:transparent;color:#7dd3fc;cursor:pointer}.inspector-tabs{display:grid;grid-template-columns:repeat(5,1fr);gap:2px;margin:12px 0}.inspector-tabs button{border:0;background:#111a2a;color:#8491a8;padding:7px 2px;font-size:9px;cursor:pointer}.inspector-tabs button.active{color:#fff;background:#20314a}.actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}.actions button,.isolate{min-height:40px}.edge-preview{display:inline-block;width:30px;height:0;border-top:2px solid #52627a;margin-right:6px;vertical-align:middle}.edge-preview.in{border-color:#60a5fa}.edge-preview.out{border-color:#f59e0b;border-top-style:dashed}.pulse{animation:pulse .7s ease-out}@keyframes pulse{50%{filter:drop-shadow(0 0 9px #fff)}}button:focus-visible,input:focus-visible,select:focus-visible,canvas:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;scroll-behavior:auto!important}}@media(max-width:1100px){.top-stats{display:none}.minimap{right:14px;top:auto;bottom:44px}.top{overflow-x:auto}.brand{display:none}}@media(max-width:900px){.minimap{right:14px}.toolbar-group.settings{display:none}}
.display-panel{position:fixed;z-index:20;top:58px;left:430px;width:250px;padding:12px;border:1px solid var(--line);border-radius:11px;background:#0d1320f5;box-shadow:0 16px 42px #000a;backdrop-filter:blur(12px)}.display-panel[hidden]{display:none}.display-panel .menu-row{display:flex;gap:5px;margin-bottom:10px}.display-panel .menu-row .fit{flex:1;min-height:40px}.display-panel .control{margin-top:4px}.lang-select{width:auto;min-height:36px;padding:5px 8px}.camera-pad[hidden]{display:none}.compact-action{white-space:nowrap}.top .modes{flex:none}@media(max-width:900px){.display-panel{left:auto;right:12px;top:58px}.compact-action.optional{display:none}}@media(max-width:650px){.display-panel{left:12px;right:12px;width:auto}.top{padding:0 8px}.lang-select{max-width:78px}}
.brand,.node-title,h1,h2,h3,summary,b,strong{font-weight:600}.guide-panel{position:absolute;z-index:18;top:14px;right:14px;bottom:14px;width:min(390px,calc(100% - 28px));padding:18px;background:#0d1320fa;border:1px solid var(--line);border-radius:13px;box-shadow:0 18px 55px #000b;overflow:auto}.guide-panel[hidden],[data-guide-lang][hidden]{display:none}.guide-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.guide-head h2{margin:0;font-size:18px}.guide-close{width:40px;height:40px;border:1px solid var(--line);border-radius:8px;background:#111a2a;color:var(--text);cursor:pointer}.guide-panel h3{margin:20px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8}.guide-panel p{margin:7px 0;color:#cbd5e1;line-height:1.55}.guide-panel dl{margin:0}.guide-panel dt{margin-top:12px;color:#e8edf7;font-weight:600}.guide-panel dd{margin:3px 0 0;color:#94a3b8;line-height:1.5}.guide-steps{margin:0;padding-left:20px;color:#cbd5e1;line-height:1.65}@media(max-width:650px){.guide-panel{top:8px;right:8px;bottom:8px;width:calc(100% - 16px)}}
.top{height:60px;padding:0 14px;background:#090f1ae8;backdrop-filter:blur(18px);box-shadow:0 1px 0 #ffffff08}.app{grid-template-rows:60px 1fr 32px}.brand{display:flex;align-items:center;gap:5px;letter-spacing:-.01em}.brand>span:first-child{color:#7dd3fc}.mode,.fit,.segmented button,.menu-popover button,.disclosure-trigger{transition:background-color .16s ease,border-color .16s ease,color .16s ease,transform .16s ease}.fit{min-height:38px;border-color:#2d3a51;background:#101827}.fit:hover,.mode:hover,.segmented button:hover,.menu-popover button:hover,.disclosure-trigger:hover{background:#19253a;color:#fff}.fit:active,.mode:active,.segmented button:active{transform:translateY(1px)}.sidebar,.inspector{top:16px;bottom:16px;border-color:#263249;border-radius:16px;background:#0b121feb;box-shadow:0 20px 60px #0008}.sidebar{padding:16px}.search{min-height:44px;padding:11px 12px;border-radius:10px;background:#080e19}.section-title{letter-spacing:.12em;color:#7d8ca6}.display-panel,.menu-popover{border:1px solid #324159;background:#0d1524f8;box-shadow:0 20px 60px #000b;backdrop-filter:blur(20px)}.display-panel{top:68px;left:410px;width:310px;padding:16px;border-radius:14px}.segmented{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:4px;border:1px solid #263249;border-radius:11px;background:#080e19}.segmented.labels-control{grid-template-columns:repeat(4,1fr)}.segmented button{min-height:38px;padding:6px;border:0;border-radius:7px;background:transparent;color:#8f9db3;cursor:pointer}.segmented button[aria-pressed="true"],.segmented button[aria-checked="true"]{background:#203451;color:#f8fafc;box-shadow:inset 0 0 0 1px #4b709b}.custom-menu{position:relative}.lang-trigger{display:flex;align-items:center;gap:7px}.menu-popover{position:absolute;z-index:30;right:0;top:46px;width:180px;padding:6px;border-radius:12px}.menu-popover[hidden]{display:none}.menu-popover button{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:40px;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:#aab5c7;cursor:pointer}.menu-popover button[aria-pressed="true"]{background:#1c2d46;color:#fff}.filter input[type="checkbox"],.community input[type="checkbox"]{appearance:none;width:18px;height:18px;margin:0;border:1px solid #40516d;border-radius:5px;background:#080e19;display:grid;place-items:center}.filter input[type="checkbox"]:checked,.community input[type="checkbox"]:checked{border-color:#60a5fa;background:#2563eb}.filter input[type="checkbox"]:checked::after,.community input[type="checkbox"]:checked::after{content:"✓";font-size:12px;color:#fff}.range-row input[type="range"]{appearance:none;height:4px;border-radius:999px;background:#334155}.range-row input[type="range"]::-webkit-slider-thumb{appearance:none;width:16px;height:16px;border-radius:50%;background:#7dd3fc;border:3px solid #0d1524;box-shadow:0 0 0 1px #5683a8}.disclosure{margin-bottom:12px}.disclosure-trigger{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:40px;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:#91a0b6;cursor:pointer;text-align:left}.disclosure-trigger::after{content:"⌄";transition:transform .16s ease}.disclosure-trigger[aria-expanded="true"]::after{transform:rotate(180deg)}.disclosure-panel[hidden]{display:none}.guide-panel{top:16px;right:16px;bottom:16px;border-radius:16px;background:#0c1422fa}.guide-close{border-radius:10px}@media(max-width:900px){.display-panel{left:auto;right:14px;top:68px}}@media(max-width:650px){.top{height:56px}.app{grid-template-rows:56px 1fr 32px}.display-panel{top:62px}.modes .mode{padding:6px 8px}}
.search-wrap{z-index:40;margin-bottom:24px}.search-wrap>label.section-title{display:block;margin:0 0 10px;line-height:1.3}.search-results{position:fixed;z-index:1000;inset:auto;max-height:min(320px,48vh);box-shadow:0 22px 55px #000e}.search-results:not(:empty){isolation:isolate}.disclosure-trigger.section-title{margin:0;line-height:1}.disclosure-trigger::after{display:grid;place-items:center;width:20px;height:20px;line-height:1;transform:translateY(-2px)}.disclosure-trigger[aria-expanded="true"]::after{transform:translateY(-2px) rotate(180deg)}
.language-menu{position:fixed;z-index:1000;inset:auto;width:180px}
</style>
</head>
<body><div class="app">
<header class="top"><div class="brand"><span>NodeNet</span> <span data-i18n="mapTitle">Governance Map</span></div><div class="modes"><button class="mode active" data-mode="architecture" data-i18n="architecture">Architecture</button><button class="mode" data-mode="governance" data-i18n="governance">Governance</button><button class="mode" data-mode="change" data-i18n="change">Change</button></div><button class="fit compact-action" id="view-toggle" aria-pressed="false">3D view</button><button class="fit compact-action" id="display-toggle" aria-expanded="false" aria-controls="display-panel" data-i18n="display">Display</button><button class="fit compact-action" id="fit" data-i18n="fitAll">Fit all</button><button class="fit compact-action optional" id="focus-selected" data-i18n="focusSelected" hidden>Focus selected</button><div class="custom-menu"><button class="fit lang-trigger" id="language-trigger" aria-expanded="false" aria-controls="language-menu"><span id="language-code">EN</span><span aria-hidden="true">⌄</span></button><div class="menu-popover language-menu" id="language-menu" hidden><button data-language="en" aria-pressed="true"><span>English</span><span>EN</span></button><button data-language="id" aria-pressed="false"><span>Indonesia</span><span>ID</span></button></div></div><div class="top-stats">${nodes.length} nodes · ${edges.length} edges</div></header>
<div class="display-panel" id="display-panel" hidden><h3 class="section-title" data-i18n="lineDisplay">Line display</h3><div class="segmented"><button id="edge-toggle" aria-pressed="false" data-i18n="hideLines">Hide lines</button><button id="all-lines" aria-pressed="false" data-i18n="allLines">All lines</button><button id="edge-mode" aria-pressed="false" data-i18n="selectedEdges">Selected</button></div><h3 class="section-title" data-i18n="labels">Labels</h3><div class="segmented labels-control" id="label-mode" role="radiogroup" aria-label="Label display"><button data-label-mode="off" role="radio" aria-checked="false" data-i18n="labelOff">Off</button><button data-label-mode="hover" role="radio" aria-checked="false" data-i18n="labelHover">Hover</button><button data-label-mode="important" role="radio" aria-checked="true" data-i18n="labelImportant">Important</button><button data-label-mode="all" role="radio" aria-checked="false" data-i18n="labelAll">All</button></div><div class="menu-row" style="margin-top:12px;margin-bottom:0"><button class="fit" id="camera-toggle" aria-pressed="false" data-i18n="cameraControls">Camera controls</button><button class="fit" id="camera-menu" aria-expanded="false" data-i18n="cycleView">Cycle view</button></div></div>
<main class="main"><aside class="sidebar"><div class="section search-wrap"><label class="section-title" for="search">Find a node</label><input id="search" class="search" placeholder="Search or kind:function…" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false"><div id="search-results" class="search-results" role="listbox"></div></div><div class="section"><h3 class="section-title">Focus scope</h3><div class="scope" id="scope"><button class="active" data-scope="1">1 hop</button><button data-scope="2">2 hops</button><button data-scope="full">Full</button></div></div><div class="section"><h3 class="section-title">Semantic islands</h3><div id="islands"></div></div><details class="section"><summary class="section-title">Communities</summary><label class="community"><input id="all-communities" type="checkbox" checked><span>All communities</span><span class="count">${communityData.length}</span></label><div id="communities"></div></details><details class="section"><summary class="section-title">Display settings</summary><h3 class="section-title">Node types</h3><label class="filter"><input type="checkbox" data-layer="code" checked><span class="mini-shape"></span>Code</label><label class="filter"><input type="checkbox" data-layer="context" checked><span class="mini-shape context"></span>Context</label><label class="filter"><input type="checkbox" data-layer="actor" checked><span class="mini-shape actor"></span>People & teams</label><h3 class="section-title">Relationships</h3><label class="filter"><input type="checkbox" data-edge="code" checked>Code</label><label class="filter"><input type="checkbox" data-edge="governance" checked>Governance</label><label class="filter"><input type="checkbox" data-edge="ownership" checked>Ownership</label><label class="filter"><input type="checkbox" data-edge="change" checked>Change impact</label><label class="range-row">Opacity<input id="edge-opacity" type="range" min="15" max="100" value="28"><span id="edge-opacity-value">28%</span></label><label class="range-row">Thickness<input id="edge-thickness" type="range" min="50" max="250" value="100"><span id="edge-thickness-value">1×</span></label><div class="empty"><span class="edge-preview in"></span>Incoming<br><span class="edge-preview out"></span>Outgoing</div></details></aside>
<section class="canvas-wrap"><canvas id="g" tabindex="0" aria-label="Interactive governance graph. Use arrow keys to move and Enter to select the nearest node."></canvas><canvas id="minimap" class="minimap" width="360" height="240" aria-label="Graph minimap"></canvas><div class="camera-pad" id="camera-pad" aria-label="Camera controls" hidden><button class="up" data-pan-y="70" aria-label="Move view up">▲</button><button class="left" data-pan-x="70" aria-label="Move view left">◀</button><button class="reset" data-reset-view aria-label="Reset camera">●</button><button class="right" data-pan-x="-70" aria-label="Move view right">▶</button><button class="down" data-pan-y="-70" aria-label="Move view down">▼</button></div><div class="tooltip" id="tooltip" role="tooltip" hidden></div><div class="help" id="help"><button id="close-help" aria-label="Dismiss guidance">×</button><b data-i18n="explore">Explore the graph</b><br><span data-i18n="helpDrag">Drag — rotate in 3D</span><br><span data-i18n="helpPan">Shift + drag — pan</span><br><span data-i18n="helpZoom">Scroll — zoom</span><br><span data-i18n="helpInspect">Click — inspect</span><br><span data-i18n="helpIsolate">Double-click — isolate</span><br><span data-i18n="helpKeys">Arrow keys — move camera</span><br><span data-i18n="helpReset">Home / 0 — reset camera</span></div><div class="canvas-hint" id="canvas-hint">Drag to pan · Scroll to zoom · Click to inspect · Double-click to isolate</div><div class="legend" id="legend"><span><b>Color</b> community</span><span><b>Shape</b> node type</span><span><b>Edges</b> <span style="color:#60a5fa">incoming</span> / <span style="color:#f59e0b">outgoing</span></span></div></section>
<aside class="inspector"><div id="info"><div class="empty">Select a node to inspect its identity, community, ownership, governance, and Evidence paths.</div></div></aside></main>
<aside class="guide-panel" id="user-guide" aria-label="User guide" hidden><div class="guide-head"><h2 data-i18n="guideTitle">User guide</h2><button class="guide-close" id="close-guide" aria-label="Close user guide">×</button></div><div data-guide-lang="en"><h3>Quick start</h3><ol class="guide-steps"><li>Choose Architecture, Governance, or Change.</li><li>Switch between 2D audit view and 3D exploration.</li><li>Search for a node, then select it to reveal its evidence.</li><li>Use 1 hop or 2 hops to control how far relationships expand.</li><li>Open Display for lines, labels, and camera options.</li></ol><h3>Terms</h3><dl><dt>Hop</dt><dd>One relationship step between two nodes. 1 hop shows direct neighbors; 2 hops also shows neighbors of those neighbors.</dd><dt>Full graph</dt><dd>Removes the hop limit and includes every visible relationship.</dd><dt>Semantic island</dt><dd>A spatial group based on function: Runtime Code, Structure, Tests & Configuration, Governance Context, or Ownership.</dd><dt>Community</dt><dd>A connectivity-based cluster. Color represents community; position represents semantic function.</dd><dt>Incoming / outgoing</dt><dd>Incoming lines point to the selected node; outgoing lines start from it.</dd><dt>Evidence path</dt><dd>A traceable relationship from code to its Context, owner, or change impact.</dd><dt>All lines</dt><dd>Shows every enabled relationship at low opacity.</dd><dt>Selected lines</dt><dd>Shows only relationships connected to the selected node.</dd><dt>Governance Context</dt><dd>A rule, decision, policy, requirement, or constraint governing code.</dd></dl></div><div data-guide-lang="id" hidden><h3>Mulai cepat</h3><ol class="guide-steps"><li>Pilih Arsitektur, Tata Kelola, atau Perubahan.</li><li>Gunakan tampilan 2D untuk audit dan 3D untuk eksplorasi.</li><li>Cari lalu pilih node untuk melihat bukti dan relasinya.</li><li>Gunakan 1 hop atau 2 hop untuk mengatur seberapa jauh relasi diperluas.</li><li>Buka Tampilan untuk mengatur garis, label, dan kamera.</li></ol><h3>Istilah</h3><dl><dt>Hop</dt><dd>Satu langkah relasi antara dua node. 1 hop menampilkan tetangga langsung; 2 hop juga menampilkan tetangga dari tetangga tersebut.</dd><dt>Grafik penuh</dt><dd>Menghapus batas hop dan menyertakan seluruh relasi yang terlihat.</dd><dt>Pulau semantik</dt><dd>Kelompok berdasarkan fungsi: Kode Runtime, Struktur, Tes & Konfigurasi, Konteks Tata Kelola, atau Kepemilikan.</dd><dt>Komunitas</dt><dd>Cluster berdasarkan keterhubungan. Warna menunjukkan komunitas; posisi menunjukkan fungsi semantik.</dd><dt>Masuk / keluar</dt><dd>Garis masuk mengarah ke node terpilih; garis keluar berawal darinya.</dd><dt>Jalur bukti</dt><dd>Relasi yang dapat ditelusuri dari kode menuju Context, pemilik, atau dampak perubahan.</dd><dt>Semua garis</dt><dd>Menampilkan seluruh relasi aktif dengan opacity rendah.</dd><dt>Garis terpilih</dt><dd>Hanya menampilkan relasi yang terhubung dengan node terpilih.</dd><dt>Konteks Tata Kelola</dt><dd>Aturan, keputusan, kebijakan, kebutuhan, atau batasan yang mengatur kode.</dd></dl></div></aside>
<footer class="status"><span id="visible-stats"></span><span id="view-status" style="margin-left:18px">2D · 100%</span><button class="help-action" id="show-help">Help</button><span id="mode-copy" class="decision">Architecture structure</span></footer></div>
<script>"use strict";(function(){
var DATA = ${payload};
var COLORS=["#38bdf8","#f59e0b","#a78bfa","#34d399","#fb7185","#22d3ee","#f472b6","#84cc16","#f97316","#60a5fa","#c084fc","#2dd4bf","#eab308","#818cf8"];
var canvas=document.getElementById("g"),ctx=canvas.getContext("2d"),wrap=canvas.parentElement,info=document.getElementById("info"),search=document.getElementById("search"),searchResults=document.getElementById("search-results"),tooltip=document.getElementById("tooltip"),mini=document.getElementById("minimap"),mctx=mini.getContext("2d");
document.body.appendChild(searchResults);function positionSearchResults(){var r=search.getBoundingClientRect(),gap=8,maxHeight=Math.min(320,innerHeight*.48),below=innerHeight-r.bottom-gap,above=r.top-gap,height=Math.min(searchResults.scrollHeight||maxHeight,maxHeight);searchResults.style.left=Math.round(r.left)+"px";searchResults.style.width=Math.round(r.width)+"px";searchResults.style.top=Math.round(below>=Math.min(180,height)||below>=above?r.bottom+gap:Math.max(gap,r.top-gap-height))+"px"}window.addEventListener("resize",positionSearchResults);
var languageTrigger=document.getElementById("language-trigger"),languageMenu=document.getElementById("language-menu");document.body.appendChild(languageMenu);function positionLanguageMenu(){var r=languageTrigger.getBoundingClientRect(),header=document.querySelector(".top").getBoundingClientRect(),gap=8,width=180,left=Math.min(innerWidth-width-8,Math.max(8,r.right-width));languageMenu.style.left=Math.round(left)+"px";languageMenu.style.top=Math.round(Math.max(r.bottom,header.bottom)+gap)+"px"}window.addEventListener("resize",positionLanguageMenu);
var initialView=new URLSearchParams(location.search).get("view"),mode="architecture",view3d=initialView==="3d",showEdges=true,allLines=false,selectedEdges=false,hopScope="1",activeIsland="",labelMode=initialView==="3d"?"hover":"important",edgeOpacity=.28,edgeThickness=1,yaw=-.45,pitch=.32,scale=1,ox=0,oy=0,selected=-1,hovered=-1,isolated=-1,drag=null,moved=false,fitted=false,searchCursor=0,pulse=-1;
var language="en",TRANSLATIONS={en:{mapTitle:"Governance Map",architecture:"Architecture",governance:"Governance",change:"Change",display:"Display",fitAll:"Fit all",focusSelected:"Focus selected",camera:"Camera",lineDisplay:"Line display",hideLines:"Hide lines",showLines:"Show lines",allLines:"All lines",selectedEdges:"Selected",labels:"Labels",labelOff:"Off",labelHover:"Hover only",labelImportant:"Important",labelAll:"All",cycleView:"Cycle camera view",explore:"Explore the graph",helpDrag:"Drag — rotate in 3D",helpPan:"Shift + drag — pan",helpZoom:"Scroll — zoom",helpInspect:"Click — inspect",helpIsolate:"Double-click — isolate",helpKeys:"Arrow keys — move camera",helpReset:"Home / 0 — reset camera",view2d:"2D view",view3d:"3D view"},id:{mapTitle:"Peta Tata Kelola",architecture:"Arsitektur",governance:"Tata Kelola",change:"Perubahan",display:"Tampilan",fitAll:"Muat semua",focusSelected:"Fokus pilihan",camera:"Kamera",lineDisplay:"Tampilan garis",hideLines:"Sembunyikan",showLines:"Tampilkan garis",allLines:"Semua garis",selectedEdges:"Terpilih",labels:"Label",labelOff:"Mati",labelHover:"Saat disorot",labelImportant:"Penting",labelAll:"Semua",cycleView:"Ganti sudut kamera",explore:"Jelajahi grafik",helpDrag:"Geser — putar dalam 3D",helpPan:"Shift + geser — pindahkan",helpZoom:"Gulir — perbesar",helpInspect:"Klik — periksa",helpIsolate:"Klik dua kali — isolasi",helpKeys:"Tombol panah — gerakkan kamera",helpReset:"Home / 0 — reset kamera",view2d:"Tampilan 2D",view3d:"Tampilan 3D"}};
Object.assign(TRANSLATIONS.en,{search:"Search nodes or use kind:function…",focusScope:"Focus scope",islands:"Semantic islands",communities:"Communities",settings:"Display settings",help:"Help",cameraControls:"Camera controls",guideTitle:"User guide"});Object.assign(TRANSLATIONS.id,{search:"Cari node atau gunakan kind:function…",focusScope:"Cakupan fokus",islands:"Pulau semantik",communities:"Komunitas",settings:"Pengaturan tampilan",help:"Bantuan",cameraControls:"Kontrol kamera",guideTitle:"Panduan pengguna"});
var headingKeys={"Focus scope":"focusScope","Semantic islands":"islands","Communities":"communities","Display settings":"settings"};document.querySelectorAll(".sidebar .section-title").forEach(function(el){var key=headingKeys[el.textContent.trim()];if(key)el.setAttribute("data-i18n",key)});document.getElementById("show-help").setAttribute("data-i18n","help");
document.querySelectorAll(".sidebar details").forEach(function(detail){var summary=detail.querySelector("summary"),shell=document.createElement("div"),trigger=document.createElement("button"),panel=document.createElement("div"),key=summary&&summary.getAttribute("data-i18n");shell.className="disclosure";trigger.className="disclosure-trigger section-title";trigger.type="button";trigger.textContent=summary?summary.textContent:"Options";trigger.setAttribute("aria-expanded","false");if(key)trigger.setAttribute("data-i18n",key);panel.className="disclosure-panel";panel.hidden=true;if(summary)summary.remove();while(detail.firstChild)panel.appendChild(detail.firstChild);trigger.onclick=function(){var open=panel.hidden;panel.hidden=!open;trigger.setAttribute("aria-expanded",String(open))};shell.appendChild(trigger);shell.appendChild(panel);detail.replaceWith(shell)});
function t(key){return(TRANSLATIONS[language]&&TRANSLATIONS[language][key])||TRANSLATIONS.en[key]||key}
function applyLanguage(next){language=next==="id"?"id":"en";document.documentElement.lang=language;document.querySelectorAll("[data-i18n]").forEach(function(el){el.textContent=t(el.getAttribute("data-i18n"))});document.querySelectorAll("[data-guide-lang]").forEach(function(el){el.hidden=el.getAttribute("data-guide-lang")!==language});document.querySelectorAll("[data-language]").forEach(function(el){el.setAttribute("aria-pressed",String(el.getAttribute("data-language")===language))});document.getElementById("language-code").textContent=language.toUpperCase();document.getElementById("view-toggle").textContent=view3d?t("view2d"):t("view3d");document.getElementById("edge-toggle").textContent=showEdges?t("hideLines"):t("showLines");search.placeholder=t("search")}
languageTrigger.onclick=function(){var open=languageMenu.hidden;if(open)positionLanguageMenu();languageMenu.hidden=!open;this.setAttribute("aria-expanded",String(open))};document.querySelectorAll("[data-language]").forEach(function(el){el.onclick=function(){applyLanguage(el.getAttribute("data-language"));languageMenu.hidden=true;languageTrigger.setAttribute("aria-expanded","false")}});
document.getElementById("display-toggle").onclick=function(){var panel=document.getElementById("display-panel"),open=panel.hidden;panel.hidden=!open;this.setAttribute("aria-expanded",String(open))};
document.getElementById("camera-toggle").onclick=function(){var pad=document.getElementById("camera-pad"),open=pad.hidden;pad.hidden=!open;this.setAttribute("aria-pressed",String(open))};
function setLabelMode(next){labelMode=next;document.querySelectorAll("[data-label-mode]").forEach(function(el){el.setAttribute("aria-checked",String(el.getAttribute("data-label-mode")===labelMode))});draw()};document.querySelectorAll("[data-label-mode]").forEach(function(el){el.onclick=function(){setLabelMode(el.getAttribute("data-label-mode"))}});
document.addEventListener("keydown",function(event){if(event.key==="Escape"){document.getElementById("display-panel").hidden=true;document.getElementById("display-toggle").setAttribute("aria-expanded","false");document.getElementById("language-menu").hidden=true;document.getElementById("language-trigger").setAttribute("aria-expanded","false")}});document.addEventListener("click",function(event){if(!event.target.closest(".custom-menu")){document.getElementById("language-menu").hidden=true;document.getElementById("language-trigger").setAttribute("aria-expanded","false")}if(!event.target.closest("#display-panel")&&!event.target.closest("#display-toggle")){document.getElementById("display-panel").hidden=true;document.getElementById("display-toggle").setAttribute("aria-expanded","false")}});
function setViewMode(next,persist){view3d=next==="3d";var toggle=document.getElementById("view-toggle");toggle.textContent=view3d?t("view2d"):t("view3d");toggle.setAttribute("aria-pressed",String(view3d));document.getElementById("canvas-hint").textContent=view3d?"Drag freely to rotate 360° · Shift+drag to pan · Scroll to zoom":"Drag to pan · Scroll to zoom · Click to inspect · Double-click to isolate";labelMode=view3d?"hover":"important";document.querySelectorAll("[data-label-mode]").forEach(function(el){el.setAttribute("aria-checked",String(el.getAttribute("data-label-mode")===labelMode))});if(persist){var url=new URL(location.href);url.searchParams.set("view",view3d?"3d":"2d");history.replaceState(null,"",url.pathname+url.search+url.hash)}if(view3d)fitSphere();else draw()}
document.getElementById("view-toggle").onclick=function(){setViewMode(view3d?"2d":"3d",true)};
document.getElementById("edge-toggle").onclick=function(){showEdges=!showEdges;this.textContent=showEdges?t("hideLines"):t("showLines");this.setAttribute("aria-pressed",String(!showEdges));draw()};
document.getElementById("all-lines").onclick=function(){allLines=!allLines;this.setAttribute("aria-pressed",String(allLines));this.classList.toggle("active",allLines);edgeOpacity=allLines?.2:.28;document.getElementById("edge-opacity").value=String(Math.round(edgeOpacity*100));document.getElementById("edge-opacity-value").textContent=Math.round(edgeOpacity*100)+"%";draw()};
document.getElementById("edge-mode").onclick=function(){selectedEdges=!selectedEdges;this.setAttribute("aria-pressed",String(selectedEdges));this.classList.toggle("active",selectedEdges);draw()};
document.getElementById("camera-pad").querySelectorAll("button").forEach(function(button){function move(){if(button.hasAttribute("data-reset-view")){ox=0;oy=0;yaw=-.45;pitch=.32;view3d?fitSphere():fitGraph(false);return}ox+=Number(button.getAttribute("data-pan-x")||0);oy+=Number(button.getAttribute("data-pan-y")||0);draw()}button.onclick=move;button.onpointerdown=function(event){event.stopPropagation()}});
window.addEventListener("keydown",function(event){var target=event.target;if(target&&("INPUT"===target.tagName||"TEXTAREA"===target.tagName||target.isContentEditable))return;var step=event.shiftKey?140:70;if(event.key==="ArrowUp")oy+=step;else if(event.key==="ArrowDown")oy-=step;else if(event.key==="ArrowLeft")ox+=step;else if(event.key==="ArrowRight")ox-=step;else if(event.key==="Home"||event.key==="0"){ox=0;oy=0;yaw=-.45;pitch=.32;view3d?fitSphere():fitGraph(false);event.preventDefault();return}else return;event.preventDefault();draw()});
var enabledCommunities=new Set(DATA.communities.map(function(c){return c.id}));var enabledLayers=new Set(["code","context","actor"]);var enabledEdges=new Set(["code","governance","ownership","change"]);var matches=new Set();
var adjacency=DATA.nodes.map(function(){return[]});DATA.edges.forEach(function(e,i){adjacency[e.s].push({edge:i,to:e.t});adjacency[e.t].push({edge:i,to:e.s})});
function focusSet(){if(selected<0||hopScope==="full")return null;var found=new Set([selected]),front=new Set([selected]),limit=Number(hopScope);for(var h=0;h<limit;h++){var next=new Set();front.forEach(function(i){adjacency[i].forEach(function(a){found.add(a.to);next.add(a.to)})});front=next}return found}
function semanticName(id){var x=DATA.islands.find(function(v){return v.id===id});return x?x.name:id}
function ownersFor(i){return adjacency[i].filter(function(a){return DATA.edges[a.edge].group==="ownership"}).map(function(a){return DATA.nodes[a.to].label})}
function contextsFor(i){return adjacency[i].filter(function(a){return DATA.edges[a.edge].group==="governance"}).map(function(a){return DATA.nodes[a.to].label})}
function esc(s){return String(s==null?"":s).replace(/[&<>\"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[c]})}
function resize(){var r=wrap.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);canvas.width=Math.max(1,Math.floor(r.width*d));canvas.height=Math.max(1,Math.floor(r.height*d));canvas.style.width=r.width+"px";canvas.style.height=r.height+"px";ctx.setTransform(d,0,0,d,0,0);if(!fitted)fitGraph(false);else draw()}
function point(n){var r=wrap.getBoundingClientRect();if(!view3d)return{x:r.width/2+n.x*scale+ox,y:r.height/2+n.y*scale+oy,depth:1,z:0};var cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch),x=n.gx*cy+n.gz*sy,z=-n.gx*sy+n.gz*cy,y=n.gy*cp-z*sp;z=n.gy*sp+z*cp;var perspective=Math.max(.48,900/(900+z));return{x:r.width/2+x*scale*perspective+ox,y:r.height/2+y*scale*perspective+oy,depth:perspective,z:z}}
function fitGraph(showAll){var r=wrap.getBoundingClientRect(),xs=DATA.nodes.map(function(n){return n.x}),ys=DATA.nodes.map(function(n){return n.y}),minX=Math.min.apply(null,xs),maxX=Math.max.apply(null,xs),minY=Math.min.apply(null,ys),maxY=Math.max.apply(null,ys),allScale=Math.min((r.width-100)/Math.max(1,maxX-minX),(r.height-100)/Math.max(1,maxY-minY),1.15);scale=showAll?allScale:Math.max(.78,allScale);ox=showAll?-(minX+maxX)/2*scale:0;oy=showAll?-(minY+maxY)/2*scale:0;fitted=true;draw()}
function fitSphere(){var r=wrap.getBoundingClientRect(),diameter=DATA.sphereRadius*2;scale=Math.max(.35,Math.min(1.15,Math.min(r.width-100,r.height-100)/diameter));ox=0;oy=0;fitted=true;draw()}
function visibleNode(n){if(!enabledCommunities.has(n.community)||!enabledLayers.has(n.layer))return false;if(activeIsland&&n.volumeGroup!==activeIsland&&n.i!==selected)return true;if(isolated>=0&&n.i!==isolated&&!adjacency[isolated].some(function(x){return x.to===n.i}))return false;var pinned=selected===n.i||hovered===n.i||matches.has(n.i)||n.changed||n.affected;if(allLines)return true;if(!view3d&&!pinned&&mode==="architecture"&&scale<.62&&n.degree<5)return false;if(!view3d&&!pinned&&mode==="architecture"&&scale<.95&&n.degree<3)return false;if(!view3d&&!pinned&&mode==="architecture"&&n.layer!=="code")return false;if(mode==="governance"&&n.layer==="code"&&n.degree<2)return pinned;if(mode==="change"){var change=n.changed||n.affected||adjacency[n.i].some(function(x){return DATA.edges[x.edge].group==="change"});if(!change&&n.layer==="code")return pinned}return true}
function visibleEdge(e){if(!showEdges||!enabledEdges.has(e.group)||!visibleNode(DATA.nodes[e.s])||!visibleNode(DATA.nodes[e.t]))return false;if(selectedEdges&&selected>=0&&selected!==e.s&&selected!==e.t)return false;var fs=focusSet();if(!allLines&&fs&&(!fs.has(e.s)||!fs.has(e.t)))return false;if(allLines)return true;if(mode==="architecture")return e.group==="code"||selected===e.s||selected===e.t;if(mode==="governance")return e.group!=="code"||selected===e.s||selected===e.t;if(mode==="change")return e.group==="change"||selected===e.s||selected===e.t;return true}
function radius(n,p){if(view3d)return Math.min(6.2,2.5+Math.sqrt(Math.max(1,n.degree))*.42)*(p?p.depth:1);return Math.min(13,3.5+Math.sqrt(Math.max(1,n.degree))*1.25)}
function nodePath(n,p,r){ctx.beginPath();if(view3d){ctx.arc(p.x,p.y,r,0,Math.PI*2);return}if(n.shape==="square"){ctx.roundRect(p.x-r,p.y-r,r*2,r*2,4)}else if(n.shape==="diamond"){ctx.moveTo(p.x,p.y-r*1.25);ctx.lineTo(p.x+r*1.25,p.y);ctx.lineTo(p.x,p.y+r*1.25);ctx.lineTo(p.x-r*1.25,p.y);ctx.closePath()}else if(n.shape==="pill"){ctx.roundRect(p.x-r*1.45,p.y-r*.75,r*2.9,r*1.5,r)}else if(n.shape==="hexagon"){for(var i=0;i<6;i++){var a=Math.PI/3*i-Math.PI/6,x=p.x+Math.cos(a)*r*1.15,y=p.y+Math.sin(a)*r*1.15;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.closePath()}else{ctx.arc(p.x,p.y,r,0,Math.PI*2)}}
function edgeStyle(e){if(e.group==="governance")return["#a78bfa",1.35];if(e.group==="ownership")return["#34d399",1.3];if(e.group==="change")return["#22d3ee",2.4];return["#52627a",1.05]}
function drawArrow(a,b,color,width,highlight,dashed,alpha,route){var dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);if(len<1)return;var ux=dx/len,uy=dy/len,rr=6,bend=Math.min(72,Math.max(10,len*.12))*(route||.35),cx=(a.x+b.x)/2-uy*bend,cy=(a.y+b.y)/2+ux*bend,ex=b.x-ux*rr,ey=b.y-uy*rr,tx=ex-cx,ty=ey-cy,tlen=Math.max(1,Math.hypot(tx,ty)),tux=tx/tlen,tuy=ty/tlen;ctx.save();ctx.globalAlpha=Math.max(.05,alpha==null?edgeOpacity:alpha);ctx.beginPath();ctx.moveTo(a.x+ux*rr,a.y+uy*rr);ctx.quadraticCurveTo(cx,cy,ex,ey);ctx.strokeStyle=color;ctx.lineCap="round";ctx.lineJoin="round";ctx.lineWidth=(highlight?width*1.8:width)*edgeThickness;ctx.setLineDash(dashed?[4,5]:[]);ctx.stroke();ctx.setLineDash([]);if(scale>=.45||highlight){ctx.beginPath();ctx.moveTo(ex,ey);ctx.lineTo(ex-tux*6-tuy*3.5,ey-tuy*6+tux*3.5);ctx.lineTo(ex-tux*6+tuy*3.5,ey-tuy*6-tux*3.5);ctx.closePath();ctx.fillStyle=color;ctx.fill()}ctx.restore()}
function drawCommunityHalos(){if(view3d)return;var groups=new Map();DATA.nodes.forEach(function(n){if(!visibleNode(n))return;var p=point(n),g=groups.get(n.community)||[];g.push(p);groups.set(n.community,g)});groups.forEach(function(points,id){if(points.length<2)return;var cx=points.reduce(function(s,p){return s+p.x},0)/points.length,cy=points.reduce(function(s,p){return s+p.y},0)/points.length,rr=28;points.forEach(function(p){rr=Math.max(rr,Math.hypot(p.x-cx,p.y-cy)+18)});var color=COLORS[id%COLORS.length];ctx.beginPath();ctx.arc(cx,cy,rr,0,Math.PI*2);ctx.fillStyle=color+"09";ctx.fill();ctx.strokeStyle=color+"28";ctx.lineWidth=1;ctx.stroke()})}
function drawMinimap(){var xs=DATA.nodes.map(function(n){return n.x}),ys=DATA.nodes.map(function(n){return n.y}),minX=Math.min.apply(null,xs),maxX=Math.max.apply(null,xs),minY=Math.min.apply(null,ys),maxY=Math.max.apply(null,ys),w=Math.max(1,maxX-minX),h=Math.max(1,maxY-minY),mx=function(x){return 16+(x-minX)/w*328},my=function(y){return 16+(y-minY)/h*208};mctx.clearRect(0,0,360,240);mctx.fillStyle="#070b14";mctx.fillRect(0,0,360,240);DATA.edges.forEach(function(e){mctx.beginPath();mctx.moveTo(mx(DATA.nodes[e.s].x),my(DATA.nodes[e.s].y));mctx.lineTo(mx(DATA.nodes[e.t].x),my(DATA.nodes[e.t].y));mctx.strokeStyle="#33415555";mctx.stroke()});DATA.islands.forEach(function(i){mctx.beginPath();mctx.arc(mx(i.x),my(i.y),6,0,Math.PI*2);mctx.fillStyle=i.id===activeIsland?"#fff":"#64748b";mctx.fill()});if(selected>=0){mctx.beginPath();mctx.arc(mx(DATA.nodes[selected].x),my(DATA.nodes[selected].y),6,0,Math.PI*2);mctx.strokeStyle="#fbbf24";mctx.lineWidth=3;mctx.stroke()}var r=wrap.getBoundingClientRect(),cx=(-ox/scale-r.width/2/scale),cy=(-oy/scale-r.height/2/scale),vw=r.width/scale,vh=r.height/scale;mctx.strokeStyle="#7dd3fc";mctx.lineWidth=2;mctx.strokeRect(mx(cx),my(cy),Math.max(12,vw/w*328),Math.max(10,vh/h*208))}
function draw(){var r=wrap.getBoundingClientRect(),fs=focusSet();ctx.clearRect(0,0,r.width,r.height);drawCommunityHalos();var projected=DATA.nodes.map(function(n){return{n:n,p:point(n)}});DATA.edges.slice().sort(function(a,b){return(Math.min(projected[a.s].p.z,projected[a.t].p.z)-Math.min(projected[b.s].p.z,projected[b.t].p.z))}).forEach(function(e){if(!visibleEdge(e))return;var a=projected[e.s].p,b=projected[e.t].p,st=edgeStyle(e),direct=selected===e.s||selected===e.t,hi=direct||hovered===e.s||hovered===e.t,alpha=edgeOpacity;if(view3d&&!direct)alpha*=Math.max(.25,Math.min(1,(a.depth+b.depth)/2));if(selected>=0&&!direct)alpha*=.16;var color=selected===e.s?"#f59e0b":selected===e.t?"#60a5fa":st[0];drawArrow(a,b,color,st[1],hi,e.evidence==="INFERRED"||e.evidence==="AMBIGUOUS"||e.rel==="conflicts_with"||selected===e.s,alpha)});projected.filter(function(x){return visibleNode(x.n)}).sort(function(a,b){return view3d?a.p.z-b.p.z:a.n.i-b.n.i}).forEach(function(x){var n=x.n,p=x.p,rr=radius(n,p),color=COLORS[n.community%COLORS.length],active=n.i===selected||n.i===hovered||matches.has(n.i),related=!fs||fs.has(n.i),islandOk=!activeIsland||n.volumeGroup===activeIsland||active;ctx.save();ctx.globalAlpha=active||n.changed||n.affected?1:(related&&islandOk?(view3d?Math.max(.42,Math.min(1,p.depth)):.92):.16);if(mode==="change"&&(n.changed||n.affected)){nodePath(n,p,rr+(n.changed?6:4));ctx.strokeStyle=n.changed?"#22d3ee":"#94a3b8";ctx.lineWidth=n.changed?2.5:1.3;ctx.stroke()}if(n.layer==="context"&&(n.authority==="HARDENED"||n.authority==="MANDATORY")){nodePath(n,p,rr+4);ctx.strokeStyle=n.enforcement==="block"?"#fb7185":"#fbbf24";ctx.lineWidth=n.authority==="MANDATORY"?2.5:1.8;ctx.stroke()}nodePath(n,p,rr);ctx.fillStyle=color;ctx.fill();ctx.strokeStyle=active?"#fff":"#08101e";ctx.lineWidth=active?2:1;ctx.stroke();var important=(scale>.7&&n.degree>=6)||scale>1.35||mode==="change"&&n.changed,showLabel=labelMode==="all"||(labelMode!=="off"&&active)||(labelMode==="important"&&important)||(labelMode==="default"&&!view3d&&important);if(showLabel){ctx.font=(active?"600 ":"")+"10px system-ui";ctx.textAlign="center";ctx.textBaseline="top";ctx.fillStyle="#e8edf7";ctx.fillText(n.label,p.x,p.y+rr+5,130)}ctx.restore()});if(view3d&&scale<1.5)DATA.islands.forEach(function(island){var p=point({gx:island.gx,gy:island.gy,gz:island.gz,x:island.x,y:island.y}),detail=scale>1.05;ctx.globalAlpha=detail?.2:.82;ctx.font="600 12px system-ui";ctx.textAlign="center";ctx.fillStyle="#cbd5e1";ctx.fillText(island.name+" · "+island.count,p.x,p.y-18)});ctx.globalAlpha=1;drawMinimap();var count=DATA.nodes.filter(visibleNode).length;document.getElementById("visible-stats").textContent=count+" visible nodes";document.getElementById("view-status").textContent=(view3d?"3D":"2D")+" · "+Math.round(scale*100)+"%"}
function hit(x,y){for(var i=DATA.nodes.length-1;i>=0;i--){var n=DATA.nodes[i];if(!visibleNode(n))continue;var p=point(n),rr=radius(n)+7;if(Math.hypot(x-p.x,y-p.y)<=rr)return i}return-1}
function inspect(i){selected=i;if(i<0){info.innerHTML='<div class="empty">Select a node to inspect its identity, relationships, governance, impact, and evidence.</div>';draw();return}var n=DATA.nodes[i],comm=DATA.communities.find(function(c){return c.id===n.community}),owners=ownersFor(i),contexts=contextsFor(i),items=adjacency[i].map(function(x){var e=DATA.edges[x.edge],t=DATA.nodes[x.to],direction=e.s===i?"Outgoing":"Incoming";return'<div class="edge-item" data-node="'+x.to+'"><div class="edge-rel">'+direction+' · '+esc(e.rel.replace(/_/g," "))+'</div><div class="edge-target">'+esc(t.full)+'</div><div class="edge-source">'+esc(e.evidence+" · "+e.source+(e.location?" · "+e.location:""))+'</div></div>'}).join(""),badges='<span class="badge">'+esc(n.kind)+'</span><span class="badge">'+esc(semanticName(n.volumeGroup))+'</span>';if(n.authority)badges+='<span class="badge '+(n.enforcement==="block"?"block":"")+'">'+esc(n.authority)+'</span>';info.innerHTML='<div class="node-title">'+esc(n.label)+'</div><div class="empty">'+esc(n.full)+'</div><div class="badges">'+badges+'</div><div class="inspector-tabs"><button class="active">Overview</button><button>Relations</button><button>Governance</button><button>Impact</button><button>Evidence</button></div><div class="kv"><div class="key">Community</div><div class="value">'+esc(comm?comm.name:"Community "+n.community)+'</div><div class="key">Connections</div><div class="value">'+n.degree+'</div><div class="key">Governed by</div><div class="value">'+esc(contexts.join(", ")||"—")+'</div><div class="key">Owner</div><div class="value">'+esc(owners.join(", ")||"—")+'</div><div class="key">Authority</div><div class="value">'+esc(n.authority||"—")+'</div></div><div class="actions"><button class="isolate" id="isolate">'+(isolated===i?"Show full graph":"Focus neighbors")+'</button><button class="isolate" id="trace-context">Trace to Context</button><button class="isolate" id="trace-owner">Trace to owner</button><button class="isolate" id="copy-id">Copy Node ID</button></div><h3 class="section-title" style="margin-top:20px">Evidence</h3><div class="edge-list">'+(items||'<div class="empty">No relationships.</div>')+'</div>';document.querySelectorAll(".edge-item").forEach(function(el){el.onclick=function(){inspect(Number(el.getAttribute("data-node")))}});document.getElementById("isolate").onclick=function(){isolated=isolated===i?-1:i;inspect(i)};document.getElementById("trace-context").onclick=function(){var target=adjacency[i].find(function(a){return DATA.edges[a.edge].group==="governance"});if(target)focusNode(target.to)};document.getElementById("trace-owner").onclick=function(){var target=adjacency[i].find(function(a){return DATA.edges[a.edge].group==="ownership"});if(target)focusNode(target.to)};document.getElementById("copy-id").onclick=function(){if(navigator.clipboard)navigator.clipboard.writeText(n.id);this.textContent="Copied"};draw()}
var inspectBase=inspect;inspect=function(i){document.getElementById("focus-selected").hidden=i<0;return inspectBase(i)};
function focusNode(i){if(i<0)return;inspect(i);var n=DATA.nodes[i],r=wrap.getBoundingClientRect(),p=point(n);ox+=r.width/2-p.x;oy+=r.height/2-p.y;scale=Math.max(scale,1.2);pulse=i;canvas.classList.add("pulse");setTimeout(function(){canvas.classList.remove("pulse");pulse=-1},700);draw()}
function buildIslands(){document.getElementById("islands").innerHTML=DATA.islands.map(function(i){return'<button class="island" data-island="'+i.id+'"><span class="island-dot"></span><span>'+esc(i.name)+'</span><span class="count">'+i.count+'</span></button>'}).join("");document.querySelectorAll("[data-island]").forEach(function(el){el.onclick=function(){var id=el.getAttribute("data-island");activeIsland=activeIsland===id?"":id;document.querySelectorAll("[data-island]").forEach(function(x){x.classList.toggle("active",x.getAttribute("data-island")===activeIsland)});if(activeIsland){var island=DATA.islands.find(function(x){return x.id===activeIsland}),r=wrap.getBoundingClientRect(),p=point({gx:island.gx,gy:island.gy,gz:island.gz,x:island.x,y:island.y});ox+=r.width/2-p.x;oy+=r.height/2-p.y;scale=Math.max(scale,1.15)}draw()}})}
function buildCommunities(){var box=document.getElementById("communities");box.innerHTML=DATA.communities.map(function(c){return'<label class="community"><input type="checkbox" data-community="'+c.id+'" checked><span class="swatch" style="background:'+COLORS[c.id%COLORS.length]+'"></span><span>'+esc(c.name)+'</span><span class="count">'+c.count+'</span></label>'}).join("");box.querySelectorAll("input").forEach(function(el){el.onchange=function(){var id=Number(el.getAttribute("data-community"));el.checked?enabledCommunities.add(id):enabledCommunities.delete(id);draw()}})}
buildCommunities();document.getElementById("fit").onclick=function(){fitGraph(true)};document.getElementById("all-communities").onchange=function(){enabledCommunities=this.checked?new Set(DATA.communities.map(function(c){return c.id})):new Set();document.querySelectorAll("[data-community]").forEach(function(x){x.checked=document.getElementById("all-communities").checked});draw()};document.querySelectorAll("[data-layer]").forEach(function(el){el.onchange=function(){var x=el.getAttribute("data-layer");el.checked?enabledLayers.add(x):enabledLayers.delete(x);draw()}});document.querySelectorAll("[data-edge]").forEach(function(el){el.onchange=function(){var x=el.getAttribute("data-edge");el.checked?enabledEdges.add(x):enabledEdges.delete(x);draw()}});document.querySelectorAll(".mode").forEach(function(el){el.onclick=function(){mode=el.getAttribute("data-mode");document.querySelectorAll(".mode").forEach(function(x){x.classList.toggle("active",x===el)});var copy=mode==="architecture"?"Architecture structure":mode==="governance"?"Context · authority · ownership":DATA.decision?("Decision: "+DATA.decision.outcome.toUpperCase()+" · "+DATA.decision.severity+" · "+DATA.decision.mode):"No change set loaded · use graph --change";document.getElementById("mode-copy").textContent=copy;document.getElementById("mode-copy").classList.toggle("block",mode==="change"&&DATA.decision&&DATA.decision.outcome==="block");isolated=-1;draw()}});search.oninput=function(){var q=search.value.toLowerCase().trim();matches=new Set();if(q)DATA.nodes.forEach(function(n){if((n.label+" "+n.full+" "+n.kind).toLowerCase().includes(q))matches.add(n.i)});draw()};search.onkeydown=function(e){if(e.key==="Enter"&&matches.size){inspect(matches.values().next().value)}};
buildIslands();applyLanguage("en");setViewMode(view3d?"3d":"2d",false);document.querySelectorAll("[data-scope]").forEach(function(el){el.onclick=function(){hopScope=el.getAttribute("data-scope");document.querySelectorAll("[data-scope]").forEach(function(x){x.classList.toggle("active",x===el)});draw()}});document.getElementById("label-mode").onchange=function(){labelMode=this.value;draw()};document.getElementById("edge-opacity").oninput=function(){edgeOpacity=Number(this.value)/100;document.getElementById("edge-opacity-value").textContent=this.value+"%";draw()};document.getElementById("edge-thickness").oninput=function(){edgeThickness=Number(this.value)/100;document.getElementById("edge-thickness-value").textContent=edgeThickness.toFixed(1)+"×";draw()};document.getElementById("focus-selected").onclick=function(){focusNode(selected)};document.getElementById("camera-menu").onclick=function(){var choice=this.dataset.view||"front",views={front:[0,0],top:[0,-Math.PI/2],side:[Math.PI/2,0]},names={front:"Front view",top:"Top view",side:"Side view"},order=["front","top","side"],next=order[(order.indexOf(choice)+1)%order.length];this.dataset.view=next;this.textContent=names[choice]+" ▾";yaw=views[choice][0];pitch=views[choice][1];draw()};document.getElementById("close-help").onclick=function(){document.getElementById("help").hidden=true};document.getElementById("show-help").onclick=function(){document.getElementById("help").hidden=false};
document.getElementById("show-help").onclick=function(){document.getElementById("help").hidden=true;document.getElementById("display-panel").hidden=true;document.getElementById("user-guide").hidden=false};document.getElementById("close-guide").onclick=function(){document.getElementById("user-guide").hidden=true};
function searchNodes(){var q=search.value.trim(),parts=q.toLowerCase().split(/\s+/),results=DATA.nodes.filter(function(n){var owners=ownersFor(n.i).join(" ").toLowerCase(),contexts=contextsFor(n.i).join(" ").toLowerCase();return parts.every(function(part){var pair=part.split(":");if(pair.length>1){if(pair[0]==="kind")return n.kind.toLowerCase().includes(pair.slice(1).join(":"));if(pair[0]==="owner")return owners.includes(pair.slice(1).join(":"));if(pair[0]==="context")return contexts.includes(pair.slice(1).join(":"))}return(n.label+" "+n.full+" "+n.kind+" "+semanticName(n.volumeGroup)).toLowerCase().includes(part)})}).slice(0,12);matches=new Set(results.map(function(n){return n.i}));searchCursor=Math.min(searchCursor,Math.max(0,results.length-1));var groups={};results.forEach(function(n){var key=semanticName(n.volumeGroup)+" · "+n.kind;(groups[key]||(groups[key]=[])).push(n)});document.getElementById("search-results").innerHTML=Object.keys(groups).map(function(key){return'<div class="section-title" style="padding:8px 10px 2px">'+esc(key)+'</div>'+groups[key].map(function(n){var pos=results.indexOf(n);return'<div class="result '+(pos===searchCursor?"active":"")+'" role="option" data-result="'+n.i+'">'+esc(n.label)+'<small>'+esc(n.full)+'</small></div>'}).join("")}).join("");search.setAttribute("aria-expanded",String(results.length>0));document.querySelectorAll("[data-result]").forEach(function(el){el.onclick=function(){focusNode(Number(el.getAttribute("data-result")));document.getElementById("search-results").innerHTML=""}});draw();return results}search.oninput=function(){searchCursor=0;searchNodes()};search.onkeydown=function(e){var results=searchNodes();if(e.key==="ArrowDown"){searchCursor=Math.min(results.length-1,searchCursor+1);e.preventDefault();searchNodes()}else if(e.key==="ArrowUp"){searchCursor=Math.max(0,searchCursor-1);e.preventDefault();searchNodes()}else if(e.key==="Enter"&&results[searchCursor]){focusNode(results[searchCursor].i);document.getElementById("search-results").innerHTML="";e.preventDefault()}else if(e.key==="Escape"){document.getElementById("search-results").innerHTML=""}};
// Double escaping is required because this client code lives in a template literal.
var SEARCH_SEPARATOR=new RegExp("\\\\s+");
function structuredSearchNodes(){var parts=search.value.toLowerCase().trim().split(SEARCH_SEPARATOR).filter(Boolean),results=DATA.nodes.filter(function(n){var owners=ownersFor(n.i).join(" ").toLowerCase(),contexts=contextsFor(n.i).join(" ").toLowerCase();return parts.every(function(part){var pair=part.split(":");if(pair.length>1&&pair[0]==="kind")return n.kind.toLowerCase().includes(pair.slice(1).join(":"));if(pair.length>1&&pair[0]==="owner")return owners.includes(pair.slice(1).join(":"));if(pair.length>1&&pair[0]==="context")return contexts.includes(pair.slice(1).join(":"));return(n.label+" "+n.full+" "+n.kind+" "+semanticName(n.volumeGroup)).toLowerCase().includes(part)})}).slice(0,12);matches=new Set(results.map(function(n){return n.i}));searchCursor=Math.min(searchCursor,Math.max(0,results.length-1));searchResults.innerHTML=results.map(function(n,index){return'<div class="result '+(index===searchCursor?"active":"")+'" role="option" data-result="'+n.i+'">'+esc(n.label)+'<small>'+esc(n.kind+" · "+semanticName(n.volumeGroup))+'</small></div>'}).join("");positionSearchResults();search.setAttribute("aria-expanded",String(results.length>0));document.querySelectorAll("[data-result]").forEach(function(el){el.onclick=function(){focusNode(Number(el.getAttribute("data-result")));searchResults.innerHTML=""}});draw();return results}
search.oninput=function(){searchCursor=0;structuredSearchNodes()};search.onkeydown=function(e){var results=structuredSearchNodes();if(e.key==="ArrowDown"){searchCursor=Math.min(results.length-1,searchCursor+1);e.preventDefault();structuredSearchNodes()}else if(e.key==="ArrowUp"){searchCursor=Math.max(0,searchCursor-1);e.preventDefault();structuredSearchNodes()}else if(e.key==="Enter"&&results[searchCursor]){focusNode(results[searchCursor].i);document.getElementById("search-results").innerHTML="";e.preventDefault()}else if(e.key==="Escape"){document.getElementById("search-results").innerHTML=""}};
canvas.onpointerdown=function(e){canvas.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY,ox:ox,oy:oy,yaw:yaw,pitch:pitch,rotate:view3d&&!e.shiftKey};moved=false;document.getElementById("help").hidden=true};canvas.onpointermove=function(e){var r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(drag){var dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)moved=true;if(drag.rotate){yaw=drag.yaw+dx*.006;pitch=drag.pitch+dy*.006}else{ox=drag.ox+dx;oy=drag.oy+dy}tooltip.hidden=true;draw()}else{var h=hit(x,y);if(h!==hovered){hovered=h;if(h>=0){var n=DATA.nodes[h],owners=ownersFor(h),contexts=contextsFor(h);tooltip.innerHTML='<strong>'+esc(n.label)+'</strong>'+esc(semanticName(n.volumeGroup))+'<br>'+n.degree+' connections<br>Governed by: '+esc(contexts[0]||"—")+'<br>Owner: '+esc(owners[0]||"—");tooltip.style.left=Math.min(r.width-260,x+16)+"px";tooltip.style.top=Math.min(r.height-130,y+16)+"px";tooltip.hidden=false}else tooltip.hidden=true;draw()}}};canvas.onpointerleave=function(){hovered=-1;tooltip.hidden=true;draw()};canvas.onpointerup=function(e){var r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(!moved)inspect(hit(x,y));drag=null};canvas.ondblclick=function(e){var r=canvas.getBoundingClientRect(),h=hit(e.clientX-r.left,e.clientY-r.top);if(h>=0){isolated=isolated===h?-1:h;inspect(h)}};canvas.onwheel=function(e){e.preventDefault();scale=Math.max(.35,Math.min(12,scale*(e.deltaY<0?1.12:.89)));document.getElementById("help").hidden=true;draw()};mini.onpointerdown=function(e){var r=mini.getBoundingClientRect(),px=(e.clientX-r.left)/r.width,py=(e.clientY-r.top)/r.height,xs=DATA.nodes.map(function(n){return n.x}),ys=DATA.nodes.map(function(n){return n.y}),x=Math.min.apply(null,xs)+px*(Math.max.apply(null,xs)-Math.min.apply(null,xs)),y=Math.min.apply(null,ys)+py*(Math.max.apply(null,ys)-Math.min.apply(null,ys));ox=-x*scale;oy=-y*scale;draw()};window.addEventListener("resize",resize);resize();inspect(-1);
})();</script></body></html>`;
}
