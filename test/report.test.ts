import { describe, it, expect } from "vitest";
import { buildFixtureState, fixtureRoot } from "./helpers.js";
import { buildReport, renderReportMarkdown } from "../src/report/report.js";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

function fixtureReport(name: string) {
  const root = fixtureRoot(name);
  const state = buildFixtureState(root);
  return { report: buildReport(state.graph, state.contexts, state.ownership, state.config, FIXED_NOW), state };
}

describe("buildReport", () => {
  it("is deterministic for identical input", () => {
    const { report: a } = fixtureReport("cross-team");
    const { report: b } = fixtureReport("cross-team");
    expect(a).toEqual(b);
  });

  it("summarizes graph size, files, symbols and communities", () => {
    const { report } = fixtureReport("cross-team");
    expect(report.summary.nodes).toBeGreaterThan(0);
    expect(report.summary.files).toBeGreaterThan(0);
    expect(report.summary.codeSymbols).toBeGreaterThan(0);
    expect(report.summary.communities).toBeGreaterThan(0);
    expect(report.summary.edges).toBeGreaterThan(0);
    expect(report.summary.nodes).toBeGreaterThan(report.summary.files);
    expect(report.summary.nodes).toBeGreaterThan(report.summary.codeSymbols);
  });

  it("finds god nodes ranked by degree with a path", () => {
    const { report } = fixtureReport("cross-team");
    expect(report.godNodes.length).toBeGreaterThan(0);
    const degrees = report.godNodes.map((g) => g.degree);
    for (let i = 1; i < degrees.length; i++) {
      expect(degrees[i - 1]).toBeGreaterThanOrEqual(degrees[i]);
    }
    const first = report.godNodes[0]!;
    expect(first.name.length).toBeGreaterThan(0);
    expect(first.path).toContain("src/");
  });

  it("filters out zero-degree symbols from god nodes", () => {
    const { report } = fixtureReport("cross-team");
    for (const g of report.godNodes) {
      expect(g.degree).toBeGreaterThan(0);
    }
  });

  it("reports governance derived from declared contexts", () => {
    const { report } = fixtureReport("cross-team");
    expect(report.governance.contexts.total).toBe(2);
    expect(report.governance.contexts.byStatus["ACTIVE"]).toBe(2);
    expect(report.governance.contexts.byAuthority["STANDARD"]).toBe(1);
    expect(report.governance.contexts.byAuthority["HARDENED"]).toBe(1);
    expect(report.governance.ownershipCoverage).toBeGreaterThan(0);
  });

  it("produces suggested questions and answers", () => {
    const { report } = fixtureReport("cross-team");
    expect(report.suggestedQuestions.length).toBeGreaterThan(0);
    for (const q of report.suggestedQuestions) {
      expect(q.question.length).toBeGreaterThan(0);
      expect(q.answer.length).toBeGreaterThan(0);
    }
  });

  it("detects cross-community file links as surprising connections", () => {
    const { report } = fixtureReport("cross-team");
    const checkoutToPayment = report.surprisingConnections.find(
      (c) =>
        c.from.includes("CheckoutService.ts") &&
        c.to.includes("PaymentService.ts") &&
        c.relation === "imports",
    );
    expect(checkoutToPayment).toBeDefined();
    expect(checkoutToPayment!.fromCommunity).not.toBe(checkoutToPayment!.toCommunity);
  });

  it("respects the godNodes and connections limit options", () => {
    const root = fixtureRoot("cross-team");
    const state = buildFixtureState(root);
    const small = buildReport(state.graph, state.contexts, state.ownership, state.config, FIXED_NOW, {
      godNodes: 1,
      connections: 1,
    });
    expect(small.godNodes.length).toBeLessThanOrEqual(1);
    expect(small.surprisingConnections.length).toBeLessThanOrEqual(1);
  });
});

describe("renderReportMarkdown", () => {
  it("renders a markdown report with all sections", () => {
    const { report } = fixtureReport("cross-team");
    const md = renderReportMarkdown(report);
    expect(md).toContain("# NodeNet Report");
    expect(md).toContain("## Summary");
    expect(md).toContain("**Nodes:**");
    expect(md).toContain("## Governance");
    expect(md).toContain("**Contexts:** 2");
    expect(md).toContain("## Suggested questions");
  });

  it("includes god nodes and communities when present", () => {
    const { report } = fixtureReport("cross-team");
    const md = renderReportMarkdown(report);
    expect(md).toContain("## God nodes");
    expect(md).toContain("| Symbol | Kind | Degree |");
    expect(md).toContain("## Communities");
    expect(md).toContain("| # | Size |");
  });
});
