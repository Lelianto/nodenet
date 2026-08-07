import { describe, it, expect } from "vitest";
import {
  canTransition,
  transitionContext,
  applyDecay,
  allTransitions,
} from "../src/context/lifecycle.js";
import { statusFromLcdd, type ContextRecord } from "../src/context/schema.js";

function record(status: ContextRecord["status"], lastReviewedAt?: string): ContextRecord {
  return {
    id: "TEST-001",
    version: 1,
    title: "Test context",
    type: "businessRule",
    status,
    authority: "STANDARD",
    approvalRequired: true,
    appliesTo: ["src/**"],
    approvedBy: ["finance-team"],
    provenance: {
      source: "test",
      createdBy: "tester",
      createdAt: "2025-01-01T00:00:00.000Z",
      ...(lastReviewedAt !== undefined ? { lastReviewedAt } : {}),
      kind: "USER_DECLARED",
      evidence: [],
    },
  };
}

describe("context lifecycle", () => {
  it("allows the canonical path DRAFT -> CANDIDATE -> APPROVED -> ACTIVE", () => {
    let ctx = record("DRAFT");
    for (const next of ["CANDIDATE", "APPROVED", "ACTIVE"] as const) {
      const result = transitionContext(ctx, next, "alice");
      expect(result.ok).toBe(true);
      if (result.ok) ctx = result.value.record;
    }
    expect(ctx.status).toBe("ACTIVE");
  });

  it("rejects ACTIVE -> DRAFT unless forced", () => {
    const ctx = record("ACTIVE");
    const result = transitionContext(ctx, "DRAFT", "alice");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Invalid lifecycle transition");
  });

  it("allows forced transitions but audits them", () => {
    const ctx = record("ACTIVE");
    const result = transitionContext(ctx, "DRAFT", "alice", true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.audit.type).toBe("context.transition");
      expect(result.value.audit.from).toBe("ACTIVE");
      expect(result.value.audit.to).toBe("DRAFT");
    }
  });

  it("supports NEEDS_REVIEW and reactivation", () => {
    const decayed = applyDecay(record("ACTIVE", "2025-01-01T00:00:00.000Z"), 30 * 24 * 60 * 60 * 1000, new Date("2025-03-01T00:00:00.000Z"));
    expect(decayed.status).toBe("NEEDS_REVIEW");
    const back = transitionContext(decayed, "ACTIVE", "alice");
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value.record.status).toBe("ACTIVE");
  });

  it("archives deprecated contexts and can revive archived ones via review", () => {
    const ctx = record("DEPRECATED");
    const archived = transitionContext(ctx, "ARCHIVED", "alice");
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    const revived = transitionContext(archived.value.record, "CANDIDATE", "alice");
    expect(revived.ok).toBe(true);
  });

  it("lists all legal transitions for policy documentation", () => {
    const transitions = allTransitions();
    expect(transitions).toContain("ACTIVE -> NEEDS_REVIEW");
    expect(transitions).toContain("ACTIVE -> DEPRECATED");
    expect(transitions).not.toContain("ACTIVE -> DRAFT");
  });

  it("maps LCDD lifecycle strings", () => {
    expect(statusFromLcdd("active")).toBe("ACTIVE");
    expect(statusFromLcdd("needs_review")).toBe("NEEDS_REVIEW");
    expect(statusFromLcdd("bogus")).toBeUndefined();
  });
});
