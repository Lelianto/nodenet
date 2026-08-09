import { describe, it, expect } from "vitest";
import { buildCodeGraph } from "../src/analyzer/code-graph.js";
import { attachGovernanceLayers } from "../src/analyzer/governance.js";
import { loadConfig } from "../src/config/config.js";
import { analyzeImpact, type ImpactReport } from "../src/change/impact.js";
import { resolveReviewers } from "../src/review/resolver.js";
import { safeRelativePath } from "../src/security/filesystem.js";
import { fixtureRoot } from "./helpers.js";
import type { ChangedHunk } from "../src/change/diff.js";

function setupCrossTeam() {
  const root = fixtureRoot("cross-team");
  const config = loadConfig(root);
  if (!config.ok) throw config.error;
  const build = buildCodeGraph(root, config.value);
  if (!build.ok) throw build.error;
  const governance = attachGovernanceLayers(build.value.graph, root, config.value);
  if (!governance.ok) throw governance.error;
  return {
    root,
    config: config.value,
    graph: build.value.graph,
    index: build.value.index,
    contexts: governance.value.contexts,
    ownership: governance.value.ownership,
  };
}

function hunk(relPath: string, addedLines: number[]): ChangedHunk {
  const safe = safeRelativePath(relPath);
  if (!safe.ok) throw safe.error;
  return { relPath: safe.value, addedLines, removedLineCount: 1, isNewFile: false, isDeletedFile: false };
}

/**
 * The NodeNet MVP (spec §72): Checkout Team changes CheckoutService,
 * which depends on PaymentService (Payment Team), governed by PAYMENT-003
 * (Finance Team approval).
 */
describe("NodeNet MVP: Checkout Team changes CheckoutService", () => {
  const ctx = setupCrossTeam();

  it("produces CHANGE IMPACT: HIGH with cross-team boundary", () => {
    const impact = analyzeImpact(ctx.root, ctx.config, ctx.graph, ctx.index, ctx.ownership, ctx.contexts, {
      changes: [hunk("src/checkout/CheckoutService.ts", [3])],
      developerTeam: "checkout-team",
    });
    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    const report = impact.value;

    // changed symbol is checkout(), not the whole file
    expect(report.changedSymbols.map((s) => s.symbolName)).toContain("checkout");
    expect(report.severity).toBe("HIGH");
    expect(report.crossTeamBoundary).toBe(true);

    // affected code includes PaymentService
    const affected = report.affectedFiles.map((f) => f.toString());
    expect(affected).toContain("src/payment/PaymentService.ts");

    // affected living context
    const contextIds = report.affectedContexts.map((c) => c.id);
    expect(contextIds).toContain("PAYMENT-003");
    expect(contextIds).toContain("SEC-009");
    expect(report.directContexts.map((context) => context.id)).toEqual(expect.arrayContaining(["PAYMENT-003", "SEC-009"]));
    expect(report.approvalFiles.map((file) => file.toString())).toContain("src/payment/PaymentService.ts");
  });

  it("resolves reviewers: payment-team required, finance-team + security-team authority", () => {
    const impact = analyzeImpact(ctx.root, ctx.config, ctx.graph, ctx.index, ctx.ownership, ctx.contexts, {
      changes: [hunk("src/checkout/CheckoutService.ts", [3])],
      developerTeam: "checkout-team",
    });
    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    const review = resolveReviewers(ctx.root, ctx.config, impact.value);

    expect(review.required.map((r) => r.target)).toContain("payment-team");
    expect(review.authorityRequired.map((r) => r.target)).toContain("finance-team");
    expect(review.authorityRequired.map((r) => r.target)).toContain("security-team");

    // explainable reasons (spec §19)
    const payment = review.required.find((r) => r.target === "payment-team");
    expect(payment?.reasons.some((r) => r.includes("owned by payment-team"))).toBe(true);
    const finance = review.authorityRequired.find((r) => r.target === "finance-team");
    expect(finance?.reasons.some((r) => r.includes("PAYMENT-003") && r.includes("approval"))).toBe(true);
    expect(finance?.score).toBe(1);
    expect(finance?.evidenceScope).toBe("direct");
  });

  it("deduplicates reviewers across sources (spec §58)", () => {
    const impact = analyzeImpact(ctx.root, ctx.config, ctx.graph, ctx.index, ctx.ownership, ctx.contexts, {
      changes: [hunk("src/checkout/CheckoutService.ts", [3])],
      developerTeam: "checkout-team",
    });
    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    const review = resolveReviewers(ctx.root, ctx.config, impact.value);
    const all = [...review.required, ...review.authorityRequired, ...review.suggested];
    const targets = all.map((r) => r.target);
    expect(new Set(targets).size).toBe(targets.length);
    // payment-team appears once, but may carry multiple reasons
    const payment = review.required.filter((r) => r.target === "payment-team");
    expect(payment.length).toBe(1);
  });

  it("escalates to CRITICAL when hardened context directly governs changed code", () => {
    // Changing PaymentService.ts directly triggers SEC-009 (HARDENED).
    const impact = analyzeImpact(ctx.root, ctx.config, ctx.graph, ctx.index, ctx.ownership, ctx.contexts, {
      changes: [hunk("src/payment/PaymentService.ts", [6])],
      developerTeam: "checkout-team",
    });
    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.value.severity).toBe("CRITICAL");
    expect(impact.value.severityReasons.some((r) => r.includes("SEC-009"))).toBe(true);
  });

  it("reports LOW severity for internal-only changes with no governance", () => {
    // A change in an ungoverned, single-team repo has no impact
    const root = fixtureRoot("basic-typescript");
    const config = loadConfig(root);
    if (!config.ok) throw config.error;
    const build = buildCodeGraph(root, config.value);
    if (!build.ok) throw build.error;
    const governance = attachGovernanceLayers(build.value.graph, root, config.value);
    if (!governance.ok) throw governance.error;
    const impact = analyzeImpact(root, config.value, build.value.graph, build.value.index, governance.value.ownership, governance.value.contexts, {
      changes: [hunk("src/app.ts", [4])],
    });
    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.value.severity).toBe("LOW");
    expect(impact.value.crossTeamBoundary).toBe(false);
    expect(impact.value.affectedContexts).toEqual([]);
  });
});

describe("impact report shape", () => {
  it("marks new and deleted files", () => {
    const ctx = setupCrossTeam();
    const newFile = safeRelativePath("src/checkout/NewService.ts");
    const deleted = safeRelativePath("src/checkout/CheckoutService.ts");
    if (!newFile.ok || !deleted.ok) throw new Error("paths");
    const impact = analyzeImpact(ctx.root, ctx.config, ctx.graph, ctx.index, ctx.ownership, ctx.contexts, {
      changes: [
        { relPath: newFile.value, addedLines: [1], removedLineCount: 0, isNewFile: true, isDeletedFile: false },
        { relPath: deleted.value, addedLines: [], removedLineCount: 5, isNewFile: false, isDeletedFile: true },
      ],
      developerTeam: "checkout-team",
    });
    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    const report = impact.value as ImpactReport;
    expect(report.changedSymbols.some((s) => s.changeKind === "added")).toBe(true);
    expect(report.changedSymbols.some((s) => s.changeKind === "removed" && s.symbolName === "checkout")).toBe(true);
  });
});
