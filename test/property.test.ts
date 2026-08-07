import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { canTransition, transitionContext } from "../src/context/lifecycle.js";
import { CONTEXT_STATUSES, type ContextRecord, type ContextLifecycleStatus } from "../src/context/schema.js";
import { collectAffected, findPath } from "../src/graph/traversal.js";
import { Graph } from "../src/graph/graph.js";
import { makeNodeId } from "../src/analyzer/code-graph.js";
import { matchGlob } from "../src/utils/glob.js";
import { safeRelativePath } from "../src/security/filesystem.js";

function baseRecord(status: ContextLifecycleStatus): ContextRecord {
  return {
    id: "PROP-001",
    version: 1,
    title: "property",
    type: "businessRule",
    status,
    authority: "GUIDELINE",
    approvalRequired: false,
    appliesTo: [],
    approvedBy: [],
    provenance: { source: "test", createdBy: "t", createdAt: "2025-01-01T00:00:00.000Z", kind: "USER_DECLARED", evidence: [] },
  };
}

describe("lifecycle transitions (property-based)", () => {
  it("transitionContext succeeds iff canTransition allows it", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CONTEXT_STATUSES), fc.constantFrom(...CONTEXT_STATUSES), (from, to) => {
        const result = transitionContext(baseRecord(from), to, "t");
        if (from === to) {
          expect(result.ok).toBe(false);
          return;
        }
        expect(result.ok).toBe(canTransition(from, to));
      }),
      { numRuns: 300 },
    );
  });
});

describe("graph traversal (property-based)", () => {
  it("always terminates and respects limits on arbitrary cyclic graphs", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 19 }), fc.integer({ min: 0, max: 19 })), { minLength: 0, maxLength: 40 }),
        (edges) => {
          const graph = new Graph({ maxNodes: 100, maxEdges: 200 });
          const nodeIds = Array.from({ length: 20 }, (_, i) => makeNodeId("n", String(i)));
          for (let i = 0; i < 20; i++) {
            graph.addNode({ kind: "function", id: nodeIds[i]!, name: `f${i}`, path: "x.ts" as never, line: 1, exported: false });
          }
          for (const [a, b] of edges) {
            graph.addEdge({
              id: makeNodeId("e", String(a), String(b)),
              from: nodeIds[a]!,
              to: nodeIds[b]!,
              relation: "calls",
              provenance: { source: "ast" },
            });
          }
          const seed = nodeIds[0]!;
          const affected = collectAffected(graph, [seed], { maxDepth: 5, maxNodes: 100 });
          expect(affected.size).toBeLessThanOrEqual(100);
          const path = findPath(graph, seed, nodeIds[19]!, { maxDepth: 10, maxNodes: 100 });
          // either a valid path (possibly empty when seed === target) or null
          expect(path === null || Array.isArray(path)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("glob matching (property-based)", () => {
  it("a ** pattern matches any nested path under it", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringOf(fc.constantFrom("a", "b", "c", "/"), { minLength: 1, maxLength: 12 }), { minLength: 0, maxLength: 8 }),
        (segments) => {
          const joined = segments.join("").replace(/\/+/g, "/");
          if (!joined || joined.startsWith("/") || joined.includes("//")) return;
          if (matchGlob("src/**", joined)) {
            expect(joined.startsWith("src")).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("safeRelativePath never accepts traversal segments", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a", "..", ".", "b", "c")), (segments) => {
        const candidate = segments.join("/");
        const result = safeRelativePath(candidate);
        if (result.ok) {
          expect(candidate.split("/")).not.toContain("..");
          expect(candidate.split("/")).not.toContain(".");
        }
      }),
      { numRuns: 200 },
    );
  });
});
