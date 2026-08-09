import { describe, it, expect } from "vitest";
import { buildFixtureState, fixtureRoot } from "./helpers.js";
import { detectCommunities } from "../src/visualization/communities.js";
import { layoutGraph } from "../src/visualization/layout.js";
import { renderGraphHtml } from "../src/visualization/html.js";
import { renderGraphSvg } from "../src/visualization/svg.js";
import type { Graph } from "../src/graph/graph.js";

function fixtureGraph(): Graph {
  const root = fixtureRoot("cross-team");
  const state = buildFixtureState(root);
  return state.graph;
}

describe("detectCommunities", () => {
  it("is deterministic", () => {
    const graph = fixtureGraph();
    const a = detectCommunities(graph);
    const b = detectCommunities(graph);
    for (const node of graph.nodes()) {
      expect(a.get(node.id)).toBe(b.get(node.id));
    }
  });

  it("produces compact ids 0..k-1", () => {
    const graph = fixtureGraph();
    const communities = detectCommunities(graph);
    const values = [...new Set([...communities.values()])].sort((a, b) => a - b);
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(values.length - 1);
  });

  it("detects at least one community and covers every node", () => {
    const graph = fixtureGraph();
    const communities = detectCommunities(graph);
    expect(communities.size).toBe(graph.size);
    expect(new Set([...communities.values()]).size).toBeGreaterThan(0);
  });
});

describe("layoutGraph", () => {
  it("is deterministic", () => {
    const graph = fixtureGraph();
    const communities = detectCommunities(graph);
    const a = layoutGraph(graph, communities, { width: 1000, height: 700, iterations: 40 });
    const b = layoutGraph(graph, communities, { width: 1000, height: 700, iterations: 40 });
    for (const node of graph.nodes()) {
      const pa = a.get(node.id)!;
      const pb = b.get(node.id)!;
      expect(pa.x).toBeCloseTo(pb.x, 5);
      expect(pa.y).toBeCloseTo(pb.y, 5);
    }
  });

  it("places every node in a finite, unbounded graph world", () => {
    const graph = fixtureGraph();
    const communities = detectCommunities(graph);
    const positions = layoutGraph(graph, communities, { width: 1000, height: 700, iterations: 40 });
    expect(positions.size).toBe(graph.size);
    for (const [, p] of positions) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Math.abs(p.x)).toBeLessThan(10_000);
      expect(Math.abs(p.y)).toBeLessThan(10_000);
    }
  });

  it("clusters nodes of the same community close together", () => {
    const graph = fixtureGraph();
    const communities = detectCommunities(graph);
    const positions = layoutGraph(graph, communities, { width: 1000, height: 700, iterations: 60 });
    // For the largest community, members must be within a bounded radius of their centroid.
    const byComm = new Map<number, { x: number; y: number }[]>();
    for (const node of graph.nodes()) {
      const c = communities.get(node.id)!;
      const list = byComm.get(c) ?? [];
      list.push(positions.get(node.id)!);
      byComm.set(c, list);
    }
    let largest = 0;
    let largestPoints: { x: number; y: number }[] = [];
    for (const [c, points] of byComm) {
      if (points.length > largest) {
        largest = points.length;
        largestPoints = points;
        void c;
      }
    }
    let cx = 0;
    let cy = 0;
    for (const p of largestPoints) {
      cx += p.x;
      cy += p.y;
    }
    cx /= largestPoints.length;
    cy /= largestPoints.length;
    let maxR = 0;
    for (const p of largestPoints) maxR = Math.max(maxR, Math.hypot(p.x - cx, p.y - cy));
    // Communities are laid out at ~130*sqrt(n) radius; check a loose bound.
    expect(maxR).toBeLessThan(130 * Math.sqrt(largest) + 60);
  });
});

describe("renderGraphHtml", () => {
  it("embeds data and interactive viewer without injecting </script>", () => {
    const graph = fixtureGraph();
    const html = renderGraphHtml(graph);
    expect(html).toContain('<canvas id="g"');
    expect(html).toContain('var DATA =');
    expect(html).toContain('id="search"');
    expect(html).toContain('id="legend"');
    expect(html).toContain('Drag to pan');
    expect(html).toContain('communities');
    expect(html).toContain('data-mode="architecture"');
    expect(html).toContain('data-mode="governance"');
    expect(html).toContain('data-mode="change"');
    expect(html).toContain('NodeNet Governance Map');
    expect(html).toContain('Evidence paths');
    expect(html).toContain('No change set loaded · use graph --change');
    expect(html).toContain('r.width/2+n.x*scale');
    expect(html).toContain('id="fit"');
    expect(html).toContain('id="view-toggle"');
    expect(html).toContain('new URLSearchParams(location.search).get("view")');
    expect(html).toContain('url.searchParams.set("view",view3d?"3d":"2d")');
    expect(html).toContain('setViewMode(view3d?"3d":"2d",false)');
    expect(html).toContain('view3d=initialView==="3d"');
    expect(html).toContain('n.gx*cy+n.gz*sy');
    expect(html).toContain('pitch=drag.pitch+dy*.006');
    expect(html).not.toContain('Math.max(-1.25');
    expect(html).toContain('if(!view3d&&!pinned&&mode==="architecture"');
    expect(html).toContain('function fitSphere()');
    expect(html).toContain('Drag freely to rotate 360°');
    expect(html).toContain('aria-label="Camera controls"');
    expect(html).toContain('aria-label="Move view left"');
    expect(html).toContain('data-reset-view');
    expect(html).toContain('canvas.onwheel=function(e){e.preventDefault();scale=');
    expect(html).toContain('Math.min(12,scale*');
    expect(html).not.toContain('ox=mx-(mx-ox)');
    expect(html).toContain('event.key==="ArrowUp"');
    expect(html).toContain('event.shiftKey?140:70');
    expect(html).toContain('target.tagName||"TEXTAREA"');
    const payloadMatch = html.match(/var DATA = (.+);\nvar COLORS=/);
    expect(payloadMatch).not.toBeNull();
    const payload = JSON.parse(payloadMatch![1]!) as {
      nodes: Array<{ gx: number; gy: number; gz: number }>;
      islands: Array<{ id: string; name: string; count: number }>;
    };
    const radii = payload.nodes.map((node) => Math.hypot(node.gx, node.gy, node.gz));
    expect(Math.min(...radii)).toBeLessThan(180);
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(100);
    expect(html).toContain('if(view3d){ctx.arc');
    expect(html).toContain('function drawCommunityHalos(){if(view3d)return;');
    expect(html).toContain('volumeGroup');
    expect(html).toContain('showLabel=labelMode==="all"');
    expect(html).toContain('id="edge-toggle"');
    expect(html).toContain('if(!showEdges||!enabledEdges.has');
    expect(html).toContain('!view3d&&!pinned&&mode==="architecture"&&n.layer!=="code"');
    expect(payload.islands.map((island) => island.name)).toEqual(expect.arrayContaining([
      "Runtime Code", "Structure", "Tests & Configuration", "Governance Context", "Ownership",
    ]));
    expect(html).toContain('data-scope="1"');
    expect(html).toContain('data-scope="2"');
    expect(html).toContain('id="minimap"');
    expect(html).toContain('id="all-lines"');
    expect(html).toContain('id="display-toggle"');
    expect(html).toContain('id="display-panel" hidden');
    expect(html).toContain('id="language-trigger"');
    expect(html).toContain('id="language-menu" hidden');
    expect(html).toContain('data-label-mode="important"');
    expect(html).not.toContain("<select");
    expect(html).toContain("document.body.appendChild(searchResults)");
    expect(html).toContain("positionSearchResults()");
    expect(html).toContain("document.body.appendChild(languageMenu)");
    expect(html).toContain("positionLanguageMenu()");
    expect(html).toContain('Peta Tata Kelola');
    expect(html).toContain('applyLanguage("en")');
    expect(html).toContain('id="camera-pad" aria-label="Camera controls" hidden');
    expect(html.match(/if\(allLines\)return true/g)).toHaveLength(2);
    expect(html).toContain('ctx.quadraticCurveTo');
    expect(html).toContain('ctx.lineCap="round"');
    expect(html).toContain('kind:function');
    expect(html).toContain('prefers-reduced-motion');
    for (const axis of ["gx", "gy", "gz"] as const) {
      const values = payload.nodes.map((node) => node[axis]);
      expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(100);
      expect(Math.abs((Math.min(...values) + Math.max(...values)) / 2)).toBeLessThan(0.00001);
    }
    // No raw closing script inside the embedded JSON.
    expect(html).not.toContain("</script>}"); // would indicate an unescaped </script> in DATA
    expect(html.indexOf("</script>")).toBeGreaterThan(0);
  });

  it("escapes HTML in node labels", () => {
    const graph = fixtureGraph();
    const html = renderGraphHtml(graph, { title: "<b>X</b>" });
    expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
  });

  it("svg export is a valid standalone image", () => {
    const graph = fixtureGraph();
    const svg = renderGraphSvg(graph);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("<circle");
    expect(svg).toContain("<line");
    expect(svg).toContain(">Code</text>");
  });
});
