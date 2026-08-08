/**
 * Interactive graph visualization (NodeNet spec §53, Phase 8).
 *
 * Generates a single self-contained HTML file (no server, no external
 * assets, no network). Contains a force-directed canvas viewer: pan/zoom,
 * hover/click inspection, neighbor highlighting, layer filters, search, and
 * community clusters. Positions and community labels are computed
 * deterministically at build time; the page never executes repository code.
 * A plain edge table remains for exact, explainable reference.
 */

import type { Graph } from "../graph/graph.js";
import { nodeLabel, type GraphNode } from "../graph/nodes.js";
import type { NodeId } from "../types/brand.js";
import type { AuthorityLevel } from "../authority/authority.js";
import { detectCommunities, type CommunityId } from "./communities.js";
import { layoutGraph, type Point } from "./layout.js";

export { renderGovernanceMap as renderGraphHtml } from "./governance-map.js";

export interface RenderOptions {
  title?: string;
  /** Abstract layout viewport (default 1000x700). */
  width?: number;
  height?: number;
  /** Force iterations (default 60). */
  iterations?: number;
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

function shortLabel(node: GraphNode): string {
  switch (node.kind) {
    case "file":
      return node.path;
    case "function":
    case "method":
      return `${node.name}()`;
    case "repository":
      return `repo:${node.name}`;
    case "workspace":
      return `ws:${node.name}`;
    case "directory":
    case "package":
      return node.name;
    default:
      return node.name;
  }
}

function layerOf(node: GraphNode): string {
  if (CODE_LAYER.has(node.kind)) return "code";
  if (ACTOR_LAYER.has(node.kind)) return "own";
  if (CONTEXT_LAYER.has(node.kind)) {
    const authority = (node as { authority?: AuthorityLevel }).authority;
    return authority === "HARDENED" || authority === "MANDATORY" ? "auth" : "ctx";
  }
  return "code";
}

export function renderGraphHtmlLegacy(graph: Graph, options: RenderOptions = {}): string {
  const title = options.title ?? "NodeNet Graph";
  const width = options.width ?? 1000;
  const height = options.height ?? 700;
  const iterations = options.iterations ?? 60;

  const communities = detectCommunities(graph);
  const positions = layoutGraph(graph, communities, { width, height, iterations });

  const nodes: GraphNode[] = [...graph.nodes()];
  const idToIndex = new Map<NodeId, number>();
  nodes.forEach((n, i) => idToIndex.set(n.id, i));

  // degree + incident edges per node
  const incident: { rel: string; to: number }[][] = nodes.map(() => []);
  const edges: { s: number; t: number; rel: string; cls: string }[] = [];
  for (const edge of graph.edges()) {
    const s = idToIndex.get(edge.from);
    const t = idToIndex.get(edge.to);
    if (s === undefined || t === undefined) continue;
    const cls = GOVERNANCE_EDGES.has(edge.relation) ? "ctx" : OWNERSHIP_EDGES.has(edge.relation) ? "own" : "code";
    edges.push({ s, t, rel: edge.relation, cls });
    incident[s]!.push({ rel: edge.relation, to: t });
    incident[t]!.push({ rel: edge.relation, to: s });
  }

  const nodeData = nodes.map((n, i) => {
    const pos = positions.get(n.id) ?? { x: width / 2, y: height / 2 };
    return {
      i,
      label: shortLabel(n),
      full: nodeLabel(n),
      kind: n.kind,
      layer: layerOf(n),
      comm: communities.get(n.id) ?? 0,
      deg: incident[i]!.length,
      x: pos.x,
      y: pos.y,
    };
  });

  // community hull metadata (centroid + radius)
  const communityMeta: { id: number; cx: number; cy: number; r: number }[] = [];
  const byComm = new Map<CommunityId, Point[]>();
  for (const n of nodeData) {
    const list = byComm.get(n.comm);
    if (list) list.push({ x: n.x, y: n.y });
    else byComm.set(n.comm, [{ x: n.x, y: n.y }]);
  }
  for (const [id, points] of byComm) {
    let cx = 0;
    let cy = 0;
    for (const p of points) {
      cx += p.x;
      cy += p.y;
    }
    cx /= points.length;
    cy /= points.length;
    let r = 10;
    for (const p of points) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d > r) r = d;
    }
    communityMeta.push({ id, cx, cy, r: r + 24 });
  }

  const dataJson = JSON.stringify({ nodes: nodeData, edges, communities: communityMeta })
    .replace(/</g, "\\u003c");

  const stats = `${nodes.length} nodes · ${graph.edgeCount} edges · ${communityMeta.length} communities`;

  // Edge table (exact, explainable reference)
  const edgeRows: string[] = [];
  const tableCap = 2000;
  for (let i = 0; i < edges.length && i < tableCap; i++) {
    const e = edges[i]!;
    const fromNode = nodes[e.s];
    const toNode = nodes[e.t];
    const fromLabel = fromNode ? nodeLabel(fromNode) : String(e.s);
    const toLabel = toNode ? nodeLabel(toNode) : String(e.t);
    edgeRows.push(
      `<tr data-from="${escapeHtml(fromLabel)}" data-to="${escapeHtml(toLabel)}" data-rel="${escapeHtml(e.rel)}" data-cls="${e.cls}"><td class="mono">${escapeHtml(fromLabel)}</td><td class="rel ${e.cls}">${e.rel.replace(/_/g, " ")}</td><td class="mono">${escapeHtml(toLabel)}</td></tr>`,
    );
  }
  const tableNote = edges.length > tableCap ? `\n<tr><td colspan="3" class="summary">… showing first ${tableCap} of ${edges.length} edges</td></tr>` : "";

  const legendHtml = Object.entries({ code: "Code", ctx: "Context", own: "Ownership", auth: "Authority" })
    .map(([layer, label]) => `<span><span class="dot" style="background:${LAYER_COLORS[layer]}"></span>${label}</span>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; color: #1f2328; background: #ffffff; }
  body.dark { color: #e6e6e6; background: #0f172a; }
  header { padding: .75rem 1rem 0; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.15rem; margin: 0; }
  .summary { color: #888; font-size: .82rem; margin-top: .2rem; }
  .toolbar { display: flex; flex-wrap: wrap; gap: .6rem 1.2rem; align-items: center; max-width: 1200px; margin: .75rem auto 0; padding: 0 1rem; }
  .toolbar input[type=text] { padding: .35rem .6rem; border: 1px solid #8888; border-radius: 6px; font-size: .85rem; min-width: 220px; background: transparent; color: inherit; }
  .legend { display: flex; flex-wrap: wrap; gap: .5rem 1rem; font-size: .78rem; align-items: center; }
  .legend span { display: inline-flex; align-items: center; gap: .3rem; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .chk { display: inline-flex; align-items: center; gap: .3rem; font-size: .8rem; cursor: pointer; }
  .wrap { position: relative; max-width: 1200px; margin: .6rem auto 0; padding: 0 1rem; }
  canvas { width: 100%; height: 620px; border: 1px solid #8884; border-radius: 8px; display: block; background: #ffffff; touch-action: none; }
  body.dark canvas { background: #0f172a; }
  .hint { font-size: .75rem; color: #888; margin-top: .3rem; }
  .panel { position: absolute; top: 12px; right: 26px; width: 300px; max-height: 70%; overflow: auto; background: #ffffffdd; backdrop-filter: blur(4px); border: 1px solid #8886; border-radius: 8px; padding: .6rem .8rem; font-size: .8rem; display: none; }
  body.dark .panel { background: #1b1f24ee; }
  .panel h2 { margin: 0 0 .4rem; font-size: .9rem; }
  .panel .meta { color: #888; font-size: .75rem; margin-bottom: .5rem; }
  .panel ul { margin: 0; padding-left: 1rem; }
  .panel li { margin: .15rem 0; }
  .panel .close { float: right; cursor: pointer; border: 0; background: none; color: inherit; font-size: 1rem; }
  details { max-width: 1200px; margin: 1.2rem auto 2rem; padding: 0 1rem; }
  details table { width: 100%; border-collapse: collapse; font-size: .8rem; }
  td, th { text-align: left; padding: 3px 8px; border-bottom: 1px solid #8882; }
  .mono { font-family: ui-monospace, monospace; }
  .rel { font-weight: 600; text-transform: uppercase; font-size: .7rem; letter-spacing: .03em; }
  .rel.code { color: #3b82f6; }
  .rel.ctx { color: #a855f7; }
  .rel.own { color: #16a34a; }
  .summary { color: #888; }
  .edgefilter { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .4rem 0; }
  .edgefilter input, .edgefilter select { padding: .3rem .6rem; border: 1px solid #8888; border-radius: 6px; font-size: .8rem; background: transparent; color: inherit; }
  .edgefilter input { min-width: 220px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <p class="summary">${stats} · generated by NodeNet · static export</p>
</header>
<div class="toolbar">
  <input type="text" id="search" placeholder="Search nodes… (Enter zooms to first match)" autocomplete="off" />
  <span class="legend" id="legend">${legendHtml}</span>
  <span id="layertoggles"></span>
</div>
<div class="wrap">
  <canvas id="g" width="1200" height="620"></canvas>
  <div class="panel" id="panel"></div>
  <p class="hint">drag = pan · scroll = zoom · hover = highlight neighbors · click = inspect · drag node = move it</p>
</div>
<details open>
  <summary>${edges.length} edges (exact)</summary>
  <div class="edgefilter">
    <input type="text" id="edgefilter" placeholder="Filter edges — from, relationship, to…" autocomplete="off" />
    <select id="edgefiltertype">
      <option value="">all types</option>
      <option value="code">code</option>
      <option value="ctx">governance</option>
      <option value="own">ownership</option>
    </select>
    <span class="summary" id="edgecount"></span>
  </div>
  <table><thead><tr><th>From</th><th>Relationship</th><th>To</th></tr></thead>
  <tbody id="edgebody">${edgeRows.join("\n")}${tableNote}</tbody></table>
</details>
<script>
"use strict";
(function () {
  var DATA = ${dataJson};
  var canvas = document.getElementById("g");
  var ctx = canvas.getContext("2d");
  var panel = document.getElementById("panel");
  var searchEl = document.getElementById("search");
  var dpr = window.devicePixelRatio || 1;

  function applyTheme() {
    if (!window.matchMedia) return;
    var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.body.classList.toggle("dark", dark);
    draw();
  }
  if (window.matchMedia) {
    var mql = window.matchMedia("(prefers-color-scheme: dark)");
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", applyTheme);
    } else if (typeof mql.addListener === "function") {
      mql.addListener(applyTheme); // legacy Safari
    }
  }

  var LAYER_COLORS = ${JSON.stringify(LAYER_COLORS)};
  var layerNames = { code: "Code", ctx: "Context", own: "Ownership", auth: "Authority" };
  var order = ["code", "ctx", "own", "auth"];

  var nodes = DATA.nodes;
  var nodeByIndex = new Map();
  nodes.forEach(function (n) { nodeByIndex.set(n.i, n); });

  var adj = new Map(); // index -> Set(index)
  nodes.forEach(function (n) { adj.set(n.i, new Set()); });
  var edgesFor = new Map(); // index -> [{rel,to}]
  nodes.forEach(function (n) { edgesFor.set(n.i, []); });
  DATA.edges.forEach(function (e) {
    adj.get(e.s).add(e.t);
    adj.get(e.t).add(e.s);
    edgesFor.get(e.s).push({ rel: e.rel, to: e.t });
    edgesFor.get(e.t).push({ rel: e.rel, to: e.s });
  });

  var hidden = {}; // layer -> bool
  var hover = -1;
  var selected = -1;
  var searchMatches = new Set();

  // transform world -> screen: sx = x*scale + ox, sy = y*scale + oy
  var scale = 1, ox = 0, oy = 0;
  var drag = null; // { mode: "pan"|"node", startX, startY, originX, originY, node }

  function fit() {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
    });
    var w = maxX - minX || 1, h = maxY - minY || 1;
    scale = Math.min((canvas.width - 80) / w, (canvas.height - 80) / h, 1.2);
    ox = canvas.width / 2 - ((minX + maxX) / 2) * scale;
    oy = canvas.height / 2 - ((minY + maxY) / 2) * scale;
  }

  function radius(n) { return Math.min(14, Math.max(3.5, 3.5 + Math.sqrt(n.deg + 1) * 1.5)); }

  function hullColor(comm) {
    var hue = (comm * 47) % 360;
    return "hsl(" + hue + " 65% 55%)";
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var active = hover !== -1 ? hover : selected;

    // community hulls
    DATA.communities.forEach(function (c) {
      var col = hullColor(c.id);
      var sx = c.cx * scale + ox, sy = c.cy * scale + oy, sr = c.r * scale;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fillStyle = col.replace("55%", "10%");
      ctx.fill();
      ctx.strokeStyle = col.replace("55%", "30%");
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // edges
    DATA.edges.forEach(function (e) {
      var a = nodeByIndex.get(e.s), b = nodeByIndex.get(e.t);
      if (hidden[a.layer] || hidden[b.layer]) return;
      var lit = active === -1 || e.s === active || e.t === active;
      var col = e.cls === "ctx" ? "#a855f7" : e.cls === "own" ? "#16a34a" : "#64748b";
      ctx.strokeStyle = lit ? col : "rgba(127,127,127,0.10)";
      ctx.lineWidth = lit && active !== -1 ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(a.x * scale + ox, a.y * scale + oy);
      ctx.lineTo(b.x * scale + ox, b.y * scale + oy);
      ctx.stroke();
    });

    // nodes
    nodes.forEach(function (n) {
      if (hidden[n.layer]) return;
      var r = radius(n);
      var x = n.x * scale + ox, y = n.y * scale + oy;
      var lit = active === -1 || n.i === active || (adj.get(active) && adj.get(active).has(n.i));
      var isMatch = searchMatches.has(n.i);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = lit ? LAYER_COLORS[n.layer] : "rgba(127,127,127,0.22)";
      ctx.fill();
      if (n.i === hover || n.i === selected) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (isMatch) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      var showLabel = scale > 0.45 || n.i === hover || n.i === selected;
      if (showLabel) {
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = lit ? (typeof document !== "undefined" && document.body.classList.contains("dark") ? "#e6e6e6" : "#1f2328") : "rgba(127,127,127,0.5)";
        var label = n.label.length > 40 ? n.label.slice(0, 38) + "…" : n.label;
        ctx.fillText(label, x, y - r - 4);
      }
    });
  }

  function hitTest(mx, my) {
    for (var i = nodes.length - 1; i >= 0; i--) {
      var n = nodes[i];
      if (hidden[n.layer]) continue;
      var x = n.x * scale + ox, y = n.y * scale + oy;
      var r = radius(n) + 3;
      if (Math.abs(mx - x) <= r && Math.abs(my - y) <= r) return n.i;
    }
    return -1;
  }

  function eventPos(evt) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: (evt.clientX - rect.left) * (canvas.width / rect.width),
      y: (evt.clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  function showTooltip(n) {
    var label = n.full;
    if (document.getElementById("tt")) {
      var tt = document.getElementById("tt");
      tt.textContent = label;
      tt.style.display = "block";
    }
  }

  canvas.addEventListener("wheel", function (evt) {
    evt.preventDefault();
    var p = eventPos(evt);
    var factor = evt.deltaY < 0 ? 1.15 : 1 / 1.15;
    var ns = Math.min(8, Math.max(0.04, scale * factor));
    ox = p.x - ((p.x - ox) / scale) * ns;
    oy = p.y - ((p.y - oy) / scale) * ns;
    scale = ns;
    draw();
  }, { passive: false });

  canvas.addEventListener("mousedown", function (evt) {
    var p = eventPos(evt);
    var hit = hitTest(p.x, p.y);
    drag = { mode: hit !== -1 ? "node" : "pan", startX: p.x, startY: p.y, originX: ox, originY: oy, node: hit };
  });

  window.addEventListener("mousemove", function (evt) {
    var p = eventPos(evt);
    if (drag) {
      if (drag.mode === "node" && drag.node !== -1) {
        var n = nodeByIndex.get(drag.node);
        n.x = (p.x - ox) / scale;
        n.y = (p.y - oy) / scale;
        draw();
      } else {
        ox = drag.originX + (p.x - drag.startX);
        oy = drag.originY + (p.y - drag.startY);
        draw();
      }
      return;
    }
    var hit = hitTest(p.x, p.y);
    if (hit !== hover) {
      hover = hit;
      if (hit === -1) {
        if (document.getElementById("tt")) document.getElementById("tt").style.display = "none";
      } else {
        showTooltip(nodeByIndex.get(hit));
      }
      draw();
    }
  });

  window.addEventListener("mouseup", function () {
    drag = null;
  });

  canvas.addEventListener("click", function () {
    if (drag && drag.mode === "node" && drag.node !== -1) {
      selected = drag.node;
      showPanel(drag.node);
      draw();
    }
  });

  function showPanel(i) {
    var n = nodeByIndex.get(i);
    var rels = edgesFor.get(i) || [];
    var rows = rels.map(function (r) {
      var other = nodeByIndex.get(r.to);
      return "<li><span class=\\"rel " + (r.rel === "governed_by" || r.rel === "applies_to" ? "ctx" : "code") + "\\">" + r.rel.replace(/_/g, " ") + "</span> → " + escapeHtml(other ? other.label : r.to) + "</li>";
    }).join("");
    panel.style.display = "block";
    panel.innerHTML = "<button class=\\"close\\" onclick=\\"document.getElementById('panel').style.display='none'\\">×</button>" +
      "<h2>" + escapeHtml(n.label) + "</h2>" +
      "<div class=\\"meta\\">" + escapeHtml(n.kind) + " · " + layerNames[n.layer] + " · community " + n.comm + " · degree " + n.deg + "</div>" +
      "<ul>" + (rows || "<li>no connections</li>") + "</ul>";
  }

  function search() {
    var q = searchEl.value.trim().toLowerCase();
    searchMatches.clear();
    if (q.length > 0) {
      nodes.forEach(function (n) {
        if (n.label.toLowerCase().indexOf(q) !== -1 || n.full.toLowerCase().indexOf(q) !== -1) {
          searchMatches.add(n.i);
        }
      });
      if (searchMatches.size > 0) {
        var first = nodeByIndex.get(searchMatches.values().next().value);
        selected = first.i;
        showPanel(first.i);
        scale = Math.max(scale, 0.9);
        ox = canvas.width / 2 - first.x * scale;
        oy = canvas.height / 2 - first.y * scale;
      }
    }
    draw();
  }
  searchEl.addEventListener("input", search);
  searchEl.addEventListener("keydown", function (evt) {
    if (evt.key === "Enter") search();
  });

  // edge table filter
  var edgeFilter = document.getElementById("edgefilter");
  var edgeFilterType = document.getElementById("edgefiltertype");
  var edgeCountEl = document.getElementById("edgecount");
  function applyEdgeFilter() {
    var q = edgeFilter.value.trim().toLowerCase();
    var type = edgeFilterType.value;
    var rows = document.querySelectorAll("#edgebody tr");
    var shown = 0;
    Array.prototype.forEach.call(rows, function (row) {
      var ok = true;
      if (type && row.getAttribute("data-cls") !== type) ok = false;
      if (ok && q) {
        var from = (row.getAttribute("data-from") || "").toLowerCase();
        var to = (row.getAttribute("data-to") || "").toLowerCase();
        var rel = (row.getAttribute("data-rel") || "").toLowerCase();
        if (from.indexOf(q) === -1 && to.indexOf(q) === -1 && rel.indexOf(q) === -1) ok = false;
      }
      row.style.display = ok ? "" : "none";
      if (ok) shown++;
    });
    if (edgeCountEl) edgeCountEl.textContent = shown + " of " + rows.length + " edges shown";
  }
  edgeFilter.addEventListener("input", applyEdgeFilter);
  edgeFilterType.addEventListener("change", applyEdgeFilter);
  applyEdgeFilter();

  // layer toggles (legend is static HTML)
  var toggles = document.getElementById("layertoggles");
  toggles.innerHTML = order.map(function (l) {
    return "<label class=\\"chk\\"><input type=\\"checkbox\\" checked data-layer=\\"" + l + "\\"> show</label>";
  }).join("");
  Array.prototype.forEach.call(toggles.querySelectorAll("input"), function (input) {
    input.addEventListener("change", function () {
      hidden[input.dataset.layer] = !input.checked;
      draw();
    });
  });

  // tooltip element
  var tt = document.createElement("div");
  tt.id = "tt";
  tt.style.cssText = "position:absolute;pointer-events:none;background:#000c;color:#fff;padding:3px 8px;border-radius:6px;font-size:12px;max-width:420px;display:none;z-index:5;";
  document.querySelector(".wrap").appendChild(tt);

  window.addEventListener("mousemove", function (evt) {
    var t = document.getElementById("tt");
    if (t && t.style.display === "block") {
      var rect = canvas.getBoundingClientRect();
      var left = evt.clientX - rect.left + 14, top = evt.clientY - rect.top + 14;
      t.style.left = Math.min(left, rect.width - 430) + "px";
      t.style.top = Math.min(top, rect.height - 40) + "px";
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  fit();
  applyTheme();
  draw();
})();
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
