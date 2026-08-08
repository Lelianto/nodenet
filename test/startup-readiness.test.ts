import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scoreBenchmark } from "../src/evaluation/benchmark.js";
import { applyDecisionOverride, isOverrideActive } from "../src/governance/audit.js";
import { buildGovernanceDecision } from "../src/governance/decision.js";
import { analyzeImpact } from "../src/change/impact.js";
import { resolveReviewers } from "../src/review/resolver.js";
import { safeRelativePath } from "../src/security/filesystem.js";
import { bootstrapRepository } from "../src/onboarding/bootstrap.js";
import { assessReadiness } from "../src/onboarding/readiness.js";
import { buildFixtureState, fixtureRoot } from "./helpers.js";

describe("startup readiness foundations", () => {
  it("scores labeled decisions with quality and latency metrics", () => {
    const metrics = scoreBenchmark([
      { id: "a", expectedOutcome: "block", actualOutcome: "block", expectedReviewers: ["security"], actualReviewers: ["security"], durationMs: 40, hardenedImpactExpected: true, hardenedImpactDetected: true },
      { id: "b", expectedOutcome: "pass", actualOutcome: "block", expectedReviewers: [], actualReviewers: ["platform"], durationMs: 10 },
    ]);
    expect(metrics.reviewerPrecision).toBe(0.5);
    expect(metrics.reviewerRecall).toBe(1);
    expect(metrics.falseBlockRate).toBe(1);
    expect(metrics.missedImpactRate).toBe(0);
    expect(metrics.outcomeAccuracy).toBe(0.5);
    expect(metrics.p50Ms).toBe(10);
    expect(metrics.p95Ms).toBe(40);
  });

  it("only applies a matching, reasoned and unexpired override", () => {
    const root = fixtureRoot("cross-team");
    const state = buildFixtureState(root);
    const file = safeRelativePath("src/payment/PaymentService.ts");
    if (!file.ok) throw file.error;
    const impact = analyzeImpact(root, state.config, state.graph, state.index, state.ownership, state.contexts, {
      changes: [{ relPath: file.value, addedLines: [2], removedLineCount: 1, isNewFile: false, isDeletedFile: false }],
    });
    if (!impact.ok) throw impact.error;
    const decision = buildGovernanceDecision(impact.value, resolveReviewers(root, state.config, impact.value), "enforce");
    const override = { decisionId: decision.decisionId, actor: "security-lead", reason: "approved emergency fix", createdAt: "2026-08-08T00:00:00.000Z", expiresAt: "2026-08-09T00:00:00.000Z" };
    expect(isOverrideActive(override, new Date("2026-08-08T12:00:00.000Z"))).toBe(true);
    expect(applyDecisionOverride(decision, override, new Date("2026-08-08T12:00:00.000Z"))).toMatchObject({ shouldFail: false, overridden: true });
    expect(() => applyDecisionOverride(decision, { ...override, decisionId: "other" })).toThrow(/does not match/);
  });

  it("bootstraps without overwriting and reports readiness", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodenet-bootstrap-"));
    const first = bootstrapRepository(root, true);
    const second = bootstrapRepository(root, true);
    expect(first.created).toContain("nodenet.config.json");
    expect(first.created).toContain(".lcdd/contexts/CHANGE-001.yaml");
    expect(first.created).toContain(".github/workflows/nodenet-governance.yml");
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(3);

    const fixtureState = buildFixtureState(fixtureRoot("cross-team"));
    const readiness = assessReadiness(fixtureRoot("cross-team"), fixtureState);
    expect(readiness.score).toBeGreaterThanOrEqual(60);
    expect(readiness.checks.map((check) => check.id)).toEqual(["config", "graph", "contexts", "ownership", "github"]);
  });
});
