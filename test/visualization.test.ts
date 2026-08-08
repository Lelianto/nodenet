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

  it("places every node inside the viewport", () => {
    const graph = fixtureGraph();
    const communities = detectCommunities(graph);
    const positions = layoutGraph(graph, communities, { width: 1000, height: 700, iterations: 40 });
    expect(positions.size).toBe(graph.size);
    for (const [, p] of positions) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1000);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(700);
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
    expect(html).toContain('n.x/DATA.width');
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
