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
  const positions = layoutGraph(graph, communities, {
    width,
    height,
    iterations: options.iterations ?? 60,
  });
  const graphNodes = [...graph.nodes()];
  const positioned = graphNodes.map((node) => positions.get(node.id) ?? { x: width / 2, y: height / 2 });
  const minX = Math.min(...positioned.map((point) => point.x));
  const maxX = Math.max(...positioned.map((point) => point.x));
  const minY = Math.min(...positioned.map((point) => point.y));
  const maxY = Math.max(...positioned.map((point) => point.y));
  const padding = Math.min(width, height) * 0.09;
  const fitScale = Math.min(
    (width - padding * 2) / Math.max(1, maxX - minX),
    (height - padding * 2) / Math.max(1, maxY - minY),
  );
  const fittedPosition = (point: { x: number; y: number }) => ({
    x: width / 2 + (point.x - (minX + maxX) / 2) * fitScale,
    y: height / 2 + (point.y - (minY + maxY) / 2) * fitScale,
  });
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

  const nodes = graphNodes.map((node, i) => {
    const position = fittedPosition(positioned[i] ?? { x: width / 2, y: height / 2 });
    const context = CONTEXT_KINDS.has(node.kind) ? node as ContextNode : undefined;
    const nodeLayer = layer(node);
    return {
      i,
      id: node.id,
      label: shortLabel(node),
      full: nodeLabel(node),
      kind: node.kind,
      layer: nodeLayer,
      shape: shape(node),
      community: communities.get(node.id) ?? 0,
      degree: degree[i] ?? 0,
      x: position.x,
      y: position.y,
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
  const payload = JSON.stringify({
    width,
    height,
    nodes,
    edges,
    communities: communityData,
    decision: options.change?.decision,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;--bg:#070b14;--panel:#0d1320;--panel2:#111a2a;--line:#253047;--text:#e8edf7;--muted:#8491a8;--accent:#7dd3fc;--danger:#fb7185;--warn:#fbbf24;--ok:#34d399}*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden}body{font:13px Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text)}button,input{font:inherit}.app{display:grid;grid-template-rows:52px 1fr 30px;height:100vh}.top{display:flex;align-items:center;gap:18px;padding:0 16px;border-bottom:1px solid var(--line);background:#0a101c}.brand{font-weight:700;letter-spacing:.01em;white-space:nowrap}.brand span{color:var(--accent)}.modes{display:flex;gap:4px;background:#080d17;border:1px solid var(--line);padding:3px;border-radius:9px}.mode{border:0;background:transparent;color:var(--muted);padding:6px 12px;border-radius:6px;cursor:pointer}.mode.active{background:#1a263a;color:#fff}.top-stats{margin-left:auto;color:var(--muted);font-size:12px}.main{display:grid;grid-template-columns:250px minmax(0,1fr) 310px;min-height:0}.sidebar,.inspector{background:var(--panel);overflow:auto}.sidebar{border-right:1px solid var(--line);padding:14px}.inspector{border-left:1px solid var(--line);padding:15px}.section{margin-bottom:20px}.section-title{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#73819a;margin:0 0 9px}.search{width:100%;background:#080d17;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 10px;outline:none}.search:focus{border-color:#46759b}.community,.filter{display:flex;align-items:center;gap:8px;padding:6px 3px;color:#c8d1e1;cursor:pointer}.community input,.filter input{accent-color:#60a5fa}.swatch{width:9px;height:9px;border-radius:50%;flex:none}.count{margin-left:auto;color:#65728a;font-size:11px}.canvas-wrap{position:relative;min-width:0;background:radial-gradient(circle at 50% 45%,#101a2a 0,#070b14 58%)}canvas{width:100%;height:100%;display:block;touch-action:none}.canvas-hint{position:absolute;left:14px;bottom:12px;color:#536078;font-size:11px;pointer-events:none}.legend{position:absolute;right:14px;bottom:12px;display:flex;gap:12px;color:#6f7d94;font-size:11px}.legend b{font-weight:500;color:#aab5c7}.empty{color:#68758c;line-height:1.55}.node-title{font-size:16px;font-weight:650;line-height:1.3;margin-bottom:5px;word-break:break-word}.badges{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0 15px}.badge{padding:3px 7px;border:1px solid #33415a;border-radius:999px;color:#b9c5d7;font-size:10px;text-transform:uppercase}.badge.block{border-color:#7f1d36;color:#fda4af;background:#3f0b19}.kv{display:grid;grid-template-columns:92px 1fr;gap:7px 10px;padding:10px 0;border-top:1px solid #1b2638}.key{color:#6f7d94}.value{color:#d4dceb;word-break:break-word}.edge-list{border-top:1px solid #1b2638}.edge-item{padding:9px 0;border-bottom:1px solid #182233;cursor:pointer}.edge-item:hover{color:#fff}.edge-rel{font-size:10px;text-transform:uppercase;color:#7dd3fc}.edge-target{margin-top:3px}.edge-source{font-size:10px;color:#65728a;margin-top:2px}.status{display:flex;align-items:center;padding:0 14px;border-top:1px solid var(--line);background:#080d17;color:#65728a;font-size:11px}.status .decision{margin-left:auto;color:#8a97ac}.status .decision.block{color:#fb7185}.shape-key{display:inline-flex;align-items:center;gap:5px}.mini-shape{display:inline-block;width:9px;height:9px;background:#8290a7}.mini-shape.context{transform:rotate(45deg)}.mini-shape.actor{width:13px;border-radius:5px}.isolate{margin-top:10px;width:100%;border:1px solid #33415a;background:#131e30;color:#cbd5e1;border-radius:7px;padding:7px;cursor:pointer}.isolate:hover{background:#1a2940}@media(max-width:900px){.main{grid-template-columns:210px 1fr}.inspector{display:none}}@media(max-width:650px){.main{grid-template-columns:1fr}.sidebar{display:none}.top-stats{display:none}}
</style>
</head>
<body><div class="app">
<header class="top"><div class="brand"><span>NodeNet</span> Governance Map</div><div class="modes"><button class="mode active" data-mode="architecture">Architecture</button><button class="mode" data-mode="governance">Governance</button><button class="mode" data-mode="change">Change</button></div><div class="top-stats">${nodes.length} nodes · ${edges.length} edges · ${communityData.length} communities</div></header>
<main class="main"><aside class="sidebar"><div class="section"><input id="search" class="search" placeholder="Search nodes…" autocomplete="off"></div><div class="section"><h3 class="section-title">Communities</h3><label class="community"><input id="all-communities" type="checkbox" checked><span>All communities</span><span class="count">${communityData.length}</span></label><div id="communities"></div></div><div class="section"><h3 class="section-title">Node types</h3><label class="filter"><input type="checkbox" data-layer="code" checked><span class="mini-shape"></span>Code</label><label class="filter"><input type="checkbox" data-layer="context" checked><span class="mini-shape context"></span>Context</label><label class="filter"><input type="checkbox" data-layer="actor" checked><span class="mini-shape actor"></span>People & teams</label></div><div class="section"><h3 class="section-title">Relationships</h3><label class="filter"><input type="checkbox" data-edge="code" checked>Code</label><label class="filter"><input type="checkbox" data-edge="governance" checked>Governance</label><label class="filter"><input type="checkbox" data-edge="ownership" checked>Ownership</label><label class="filter"><input type="checkbox" data-edge="change" checked>Change impact</label></div></aside>
<section class="canvas-wrap"><canvas id="g"></canvas><div class="canvas-hint">Drag to pan · Scroll to zoom · Click to inspect · Double-click to isolate</div><div class="legend" id="legend"><span><b>Color</b> community</span><span><b>Shape</b> node type</span><span><b>Size</b> connectivity</span><span><b>Ring</b> authority</span></div></section>
<aside class="inspector"><div id="info"><div class="empty">Select a node to inspect its identity, community, ownership, governance, and evidence paths.</div></div></aside></main>
<footer class="status"><span id="visible-stats"></span><span id="mode-copy" class="decision">Architecture structure</span></footer></div>
<script>"use strict";(function(){
var DATA = ${payload};
var COLORS=["#38bdf8","#f59e0b","#a78bfa","#34d399","#fb7185","#22d3ee","#f472b6","#84cc16","#f97316","#60a5fa","#c084fc","#2dd4bf","#eab308","#818cf8"];
var canvas=document.getElementById("g"),ctx=canvas.getContext("2d"),wrap=canvas.parentElement,info=document.getElementById("info"),search=document.getElementById("search");
var mode="architecture",scale=1,ox=0,oy=0,selected=-1,hovered=-1,isolated=-1,drag=null,moved=false;
var enabledCommunities=new Set(DATA.communities.map(function(c){return c.id}));var enabledLayers=new Set(["code","context","actor"]);var enabledEdges=new Set(["code","governance","ownership","change"]);var matches=new Set();
var adjacency=DATA.nodes.map(function(){return[]});DATA.edges.forEach(function(e,i){adjacency[e.s].push({edge:i,to:e.t});adjacency[e.t].push({edge:i,to:e.s})});
function esc(s){return String(s==null?"":s).replace(/[&<>\"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[c]})}
function resize(){var r=wrap.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);canvas.width=Math.max(1,Math.floor(r.width*d));canvas.height=Math.max(1,Math.floor(r.height*d));canvas.style.width=r.width+"px";canvas.style.height=r.height+"px";ctx.setTransform(d,0,0,d,0,0);draw()}
function point(n){var r=wrap.getBoundingClientRect();return{x:(n.x/DATA.width*r.width)*scale+ox,y:(n.y/DATA.height*r.height)*scale+oy}}
function visibleNode(n){if(!enabledCommunities.has(n.community)||!enabledLayers.has(n.layer))return false;if(isolated>=0&&n.i!==isolated&&!adjacency[isolated].some(function(x){return x.to===n.i}))return false;if(mode==="architecture"&&n.layer!=="code")return selected===n.i||hovered===n.i;if(mode==="governance"&&n.layer==="code"&&n.degree<2)return selected===n.i||hovered===n.i;if(mode==="change"){var change=n.changed||n.affected||adjacency[n.i].some(function(x){return DATA.edges[x.edge].group==="change"});if(!change&&n.layer==="code")return selected===n.i||hovered===n.i}return true}
function visibleEdge(e){if(!enabledEdges.has(e.group)||!visibleNode(DATA.nodes[e.s])||!visibleNode(DATA.nodes[e.t]))return false;if(mode==="architecture")return e.group==="code";if(mode==="governance")return e.group!=="code"||selected===e.s||selected===e.t;if(mode==="change")return e.group==="change"||selected===e.s||selected===e.t;return true}
function radius(n){return Math.min(25,7+Math.sqrt(Math.max(1,n.degree))*2.3)}
function nodePath(n,p,r){ctx.beginPath();if(n.shape==="square"){ctx.roundRect(p.x-r,p.y-r,r*2,r*2,4)}else if(n.shape==="diamond"){ctx.moveTo(p.x,p.y-r*1.25);ctx.lineTo(p.x+r*1.25,p.y);ctx.lineTo(p.x,p.y+r*1.25);ctx.lineTo(p.x-r*1.25,p.y);ctx.closePath()}else if(n.shape==="pill"){ctx.roundRect(p.x-r*1.45,p.y-r*.75,r*2.9,r*1.5,r)}else if(n.shape==="hexagon"){for(var i=0;i<6;i++){var a=Math.PI/3*i-Math.PI/6,x=p.x+Math.cos(a)*r*1.15,y=p.y+Math.sin(a)*r*1.15;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.closePath()}else{ctx.arc(p.x,p.y,r,0,Math.PI*2)}}
function edgeStyle(e){if(e.group==="governance")return["#a78bfa",1.25];if(e.group==="ownership")return["#34d399",1.2];if(e.group==="change")return["#22d3ee",2.4];return["#334155",.8]}
function drawArrow(a,b,color,width,highlight,dashed){var dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);if(len<1)return;var ux=dx/len,uy=dy/len,rr=8;ctx.beginPath();ctx.moveTo(a.x+ux*rr,a.y+uy*rr);ctx.lineTo(b.x-ux*rr,b.y-uy*rr);ctx.strokeStyle=highlight?color:color+"99";ctx.lineWidth=highlight?width*2:width;ctx.setLineDash(dashed?[4,5]:[]);ctx.stroke();ctx.setLineDash([]);var x=b.x-ux*rr,y=b.y-uy*rr;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x-ux*7-uy*4,y-uy*7+ux*4);ctx.lineTo(x-ux*7+uy*4,y-uy*7-ux*4);ctx.closePath();ctx.fillStyle=color;ctx.fill()}
function draw(){var r=wrap.getBoundingClientRect();ctx.clearRect(0,0,r.width,r.height);DATA.edges.forEach(function(e){if(!visibleEdge(e))return;var a=point(DATA.nodes[e.s]),b=point(DATA.nodes[e.t]),st=edgeStyle(e),hi=selected===e.s||selected===e.t||hovered===e.s||hovered===e.t;drawArrow(a,b,st[0],st[1],hi,e.evidence==="INFERRED"||e.evidence==="AMBIGUOUS"||e.rel==="conflicts_with")});DATA.nodes.forEach(function(n){if(!visibleNode(n))return;var p=point(n),rr=radius(n),color=COLORS[n.community%COLORS.length],active=n.i===selected||n.i===hovered||matches.has(n.i);if(mode==="change"&&(n.changed||n.affected)){nodePath(n,p,rr+(n.changed?8:5));ctx.strokeStyle=n.changed?"#22d3ee":"#64748b";ctx.lineWidth=n.changed?3:1.5;ctx.stroke()}if(n.layer==="context"&&(n.authority==="HARDENED"||n.authority==="MANDATORY")){nodePath(n,p,rr+5);ctx.strokeStyle=n.enforcement==="block"?"#fb7185":"#fbbf24";ctx.lineWidth=n.authority==="MANDATORY"?3:2;ctx.stroke()}nodePath(n,p,rr);ctx.fillStyle=color+(mode==="architecture"&&n.layer!=="code"?"44":"dd");ctx.fill();ctx.strokeStyle=active?"#fff":"#0b1020";ctx.lineWidth=active?2.2:1.2;ctx.stroke();if(active||n.degree>=6||scale>1.55||mode==="change"&&n.changed){ctx.font=(active?"600 ":"")+"11px system-ui";ctx.textAlign="center";ctx.textBaseline="top";ctx.fillStyle="#e8edf7";ctx.fillText(n.label,p.x,p.y+rr+6,150)}});var count=DATA.nodes.filter(visibleNode).length;document.getElementById("visible-stats").textContent=count+" visible nodes"}
function hit(x,y){for(var i=DATA.nodes.length-1;i>=0;i--){var n=DATA.nodes[i];if(!visibleNode(n))continue;var p=point(n),rr=radius(n)+7;if(Math.hypot(x-p.x,y-p.y)<=rr)return i}return-1}
function inspect(i){selected=i;if(i<0){info.innerHTML='<div class="empty">Select a node to inspect its identity, community, ownership, governance, and evidence paths.</div>';draw();return}var n=DATA.nodes[i],comm=DATA.communities.find(function(c){return c.id===n.community}),items=adjacency[i].map(function(x){var e=DATA.edges[x.edge],t=DATA.nodes[x.to];return'<div class="edge-item" data-node="'+x.to+'"><div class="edge-rel">'+esc(e.rel.replace(/_/g," "))+' →</div><div class="edge-target">'+esc(t.full)+'</div><div class="edge-source">'+esc(e.evidence+" · "+e.source+(e.location?" · "+e.location:""))+'</div></div>'}).join("");var badges='<span class="badge">'+esc(n.kind)+'</span><span class="badge">'+esc(n.layer)+'</span>';if(n.authority)badges+='<span class="badge '+(n.enforcement==="block"?"block":"")+'">'+esc(n.authority)+'</span>';if(n.enforcement)badges+='<span class="badge '+(n.enforcement==="block"?"block":"")+'">'+esc(n.enforcement)+'</span>';info.innerHTML='<div class="node-title">'+esc(n.label)+'</div><div class="empty">'+esc(n.full)+'</div><div class="badges">'+badges+'</div><div class="kv"><div class="key">Community</div><div class="value">'+esc(comm?comm.name:"Community "+n.community)+'</div><div class="key">Connections</div><div class="value">'+n.degree+'</div><div class="key">Lifecycle</div><div class="value">'+esc(n.status||"—")+'</div><div class="key">Authority</div><div class="value">'+esc(n.authority||"—")+'</div><div class="key">Classification</div><div class="value">'+esc(n.classification||"—")+'</div><div class="key">Source</div><div class="value">'+esc(n.sourceFormat||"graph")+'</div></div><button class="isolate" id="isolate">'+(isolated===i?"Show full graph":"Isolate neighbors")+'</button><h3 class="section-title" style="margin-top:20px">Evidence paths</h3><div class="edge-list">'+(items||'<div class="empty">No relationships.</div>')+'</div>';document.querySelectorAll(".edge-item").forEach(function(el){el.onclick=function(){inspect(Number(el.getAttribute("data-node")))}});document.getElementById("isolate").onclick=function(){isolated=isolated===i?-1:i;inspect(i)};draw()}
function buildCommunities(){var box=document.getElementById("communities");box.innerHTML=DATA.communities.map(function(c){return'<label class="community"><input type="checkbox" data-community="'+c.id+'" checked><span class="swatch" style="background:'+COLORS[c.id%COLORS.length]+'"></span><span>'+esc(c.name)+'</span><span class="count">'+c.count+'</span></label>'}).join("");box.querySelectorAll("input").forEach(function(el){el.onchange=function(){var id=Number(el.getAttribute("data-community"));el.checked?enabledCommunities.add(id):enabledCommunities.delete(id);draw()}})}
buildCommunities();document.getElementById("all-communities").onchange=function(){enabledCommunities=this.checked?new Set(DATA.communities.map(function(c){return c.id})):new Set();document.querySelectorAll("[data-community]").forEach(function(x){x.checked=document.getElementById("all-communities").checked});draw()};document.querySelectorAll("[data-layer]").forEach(function(el){el.onchange=function(){var x=el.getAttribute("data-layer");el.checked?enabledLayers.add(x):enabledLayers.delete(x);draw()}});document.querySelectorAll("[data-edge]").forEach(function(el){el.onchange=function(){var x=el.getAttribute("data-edge");el.checked?enabledEdges.add(x):enabledEdges.delete(x);draw()}});document.querySelectorAll(".mode").forEach(function(el){el.onclick=function(){mode=el.getAttribute("data-mode");document.querySelectorAll(".mode").forEach(function(x){x.classList.toggle("active",x===el)});var copy=mode==="architecture"?"Architecture structure":mode==="governance"?"Context · authority · ownership":DATA.decision?("Decision: "+DATA.decision.outcome.toUpperCase()+" · "+DATA.decision.severity+" · "+DATA.decision.mode):"No change set loaded · use graph --change";document.getElementById("mode-copy").textContent=copy;document.getElementById("mode-copy").classList.toggle("block",mode==="change"&&DATA.decision&&DATA.decision.outcome==="block");isolated=-1;draw()}});search.oninput=function(){var q=search.value.toLowerCase().trim();matches=new Set();if(q)DATA.nodes.forEach(function(n){if((n.label+" "+n.full+" "+n.kind).toLowerCase().includes(q))matches.add(n.i)});draw()};search.onkeydown=function(e){if(e.key==="Enter"&&matches.size){inspect(matches.values().next().value)}};
canvas.onpointerdown=function(e){canvas.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY,ox:ox,oy:oy};moved=false};canvas.onpointermove=function(e){var r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(drag){var dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)moved=true;ox=drag.ox+dx;oy=drag.oy+dy;draw()}else{var h=hit(x,y);if(h!==hovered){hovered=h;draw()}}};canvas.onpointerup=function(e){var r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(!moved)inspect(hit(x,y));drag=null};canvas.ondblclick=function(e){var r=canvas.getBoundingClientRect(),h=hit(e.clientX-r.left,e.clientY-r.top);if(h>=0){isolated=isolated===h?-1:h;inspect(h)}};canvas.onwheel=function(e){e.preventDefault();var r=canvas.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top,old=scale;scale=Math.max(.35,Math.min(4,scale*(e.deltaY<0?1.12:.89)));ox=mx-(mx-ox)*(scale/old);oy=my-(my-oy)*(scale/old);draw()};window.addEventListener("resize",resize);resize();inspect(-1);
})();</script></body></html>`;
}
