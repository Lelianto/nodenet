import { describe, it, expect } from "vitest";
import { buildCodeGraph } from "../src/analyzer/code-graph.js";
import { loadConfig } from "../src/config/config.js";
import { findPath, neighbors } from "../src/graph/traversal.js";
import { fixtureRoot } from "./helpers.js";
import type { Graph } from "../src/graph/graph.js";
import type { LoadedConfig } from "../src/config/config.js";

function build(name: string): { graph: Graph; config: LoadedConfig; warnings: string[] } {
  const root = fixtureRoot(name);
  const config = loadConfig(root);
  if (!config.ok) throw config.error;
  const result = buildCodeGraph(root, config.value);
  if (!result.ok) throw result.error;
  return { graph: result.value.graph, config: config.value, warnings: result.value.warnings };
}

function nodes(graph: Graph, kind: string, name: string) {
  return graph.findNodes((n) => n.kind === kind && n.name === name);
}

describe("code graph", () => {
  it("builds functions, interfaces, variables and calls (basic-typescript)", () => {
    const { graph } = build("basic-typescript");
    expect(nodes(graph, "function", "add").length).toBeGreaterThanOrEqual(1);
    expect(nodes(graph, "interface", "Vec").length).toBe(1);
    expect(nodes(graph, "variable", "PI").length).toBe(1);

    const main = nodes(graph, "function", "main")[0];
    expect(main).toBeDefined();
    const calls = graph.out(main!.id).filter((e) => e.relation === "calls");
    const targets = calls.map((e) => graph.getNode(e.to)?.name);
    expect(targets).toContain("add");
  });

  it("creates file-level imports and exports edges", () => {
    const { graph } = build("basic-typescript");
    const appFile = graph.findNodes((n) => n.kind === "file" && n.name === "app.ts")[0];
    expect(appFile).toBeDefined();
    const imports = graph.out(appFile!.id).filter((e) => e.relation === "imports");
    expect(imports.length).toBeGreaterThanOrEqual(1);
    const target = graph.getNode(imports[0]!.to);
    expect(target?.kind === "file" && (target as { name: string }).name === "math.ts").toBe(true);
  });

  it("detects test relationships", () => {
    const { graph } = build("basic-typescript");
    const testFile = graph.findNodes((n) => n.kind === "file" && n.name === "math.test.ts")[0];
    expect(testFile).toBeDefined();
    const testsEdges = graph.out(testFile!.id).filter((e) => e.relation === "tests");
    expect(testsEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("finds a path between main and add via trace", () => {
    const { graph, config } = build("basic-typescript");
    const main = nodes(graph, "function", "main")[0];
    const add = nodes(graph, "function", "add")[0];
    expect(main).toBeDefined();
    expect(add).toBeDefined();
    const chain = findPath(
      graph,
      main!.id,
      add!.id,
      { maxDepth: config.limits.maxTraversalDepth, maxNodes: config.limits.maxTraversalNodes },
      (e) => e.relation !== "contains",
    );
    expect(chain).not.toBeNull();
    expect(chain!.length).toBeGreaterThanOrEqual(1);
  });

  it("lists neighbors via related", () => {
    const { graph } = build("basic-typescript");
    const add = nodes(graph, "function", "add")[0];
    const related = neighbors(graph, add!.id);
    const names = related.map((r) => r.node.name);
    expect(names).toContain("main"); // caller symbol
  });

  it("handles circular dependencies without infinite loops", () => {
    const { graph } = build("circular-dependency");
    expect(nodes(graph, "function", "a").length).toBe(1);
    expect(nodes(graph, "function", "b").length).toBe(1);
    // a calls b and b calls a
    const a = nodes(graph, "function", "a")[0];
    const calls = graph.out(a!.id).map((e) => graph.getNode(e.to)?.name);
    expect(calls).toContain("b");
  });

  it("skips malformed source with warnings but keeps valid files", () => {
    const { graph, warnings } = build("malformed-source");
    expect(nodes(graph, "function", "fine").length).toBe(1);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.join("\n")).toMatch(/syntax|parse|error/i);
  });

  it("detects React components, hooks and renders edges", () => {
    const { graph } = build("react-app");
    const app = nodes(graph, "reactComponent", "App")[0];
    const button = nodes(graph, "reactComponent", "Button")[0];
    const hook = nodes(graph, "reactHook", "useCounter")[0];
    expect(app).toBeDefined();
    expect(button).toBeDefined();
    expect(hook).toBeDefined();
    const renders = graph.out(app!.id).filter((e) => e.relation === "renders");
    const targets = renders.map((e) => graph.getNode(e.to)?.name);
    expect(targets).toContain("Button");
    // App calls useCounter
    const calls = graph.out(app!.id).filter((e) => e.relation === "calls");
    expect(calls.map((e) => graph.getNode(e.to)?.name)).toContain("useCounter");
  });

  it("builds monorepo packages with workspace dependency edges", () => {
    const { graph } = build("monorepo");
    const corePkg = graph.findNodes((n) => n.kind === "package" && n.name === "@mono/core");
    const appPkg = graph.findNodes((n) => n.kind === "package" && n.name === "@mono/app");
    expect(corePkg.length).toBe(1);
    expect(appPkg.length).toBe(1);
    const depends = graph.out(appPkg[0]!.id).filter((e) => e.relation === "depends_on");
    expect(depends.map((e) => e.to)).toContain(corePkg[0]!.id);
    // cross-package call resolution
    const main = nodes(graph, "function", "appMain")[0];
    const calls = graph.out(main!.id).filter((e) => e.relation === "calls");
    expect(calls.map((e) => graph.getNode(e.to)?.name)).toContain("coreValue");
  });
});
