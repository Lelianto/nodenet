import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { validateContextFull } from "@lcdd/core";
import { loadContexts } from "../src/context/loader.js";
import { legacyToLcddContext } from "../src/context/lcdd.js";
import { buildGovernanceDecision } from "../src/governance/decision.js";
import { analyzeImpact } from "../src/change/impact.js";
import { resolveReviewers } from "../src/review/resolver.js";
import { safeRelativePath } from "../src/security/filesystem.js";
import { buildFixtureState, copyFixture, fixtureRoot, tmpDir } from "./helpers.js";
import type { ChangedHunk } from "../src/change/diff.js";

function changed(pathname: string): ChangedHunk {
  const relative = safeRelativePath(pathname);
  if (!relative.ok) throw relative.error;
  return {
    relPath: relative.value,
    addedLines: [1],
    removedLineCount: 0,
    isNewFile: false,
    isDeletedFile: false,
  };
}

describe("LCDD 0.6 compatibility", () => {
  it("loads, validates, and losslessly retains canonical Registry Contexts", () => {
    const root = fixtureRoot("lcdd-canonical");
    const loaded = loadContexts(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.warnings).toEqual([]);
    expect(loaded.value.contexts).toHaveLength(1);

    const context = loaded.value.contexts[0];
    expect(context?.id).toBe("PAYMENT-100");
    expect(context?.sourceFormat).toBe("lcdd-0.6");
    expect(context?.authority).toBe("HARDENED");
    expect(context?.enforcementMode).toBe("block");
    expect(context?.canonical?.source.type).toBe("regulatory");
    expect(context?.canonical?.evidence?.[0]?.uri).toBe("https://example.com/payment-rule");
  });

  it("uses canonical lifecycle and enforcement in governance decisions", () => {
    const root = fixtureRoot("lcdd-canonical");
    const state = buildFixtureState(root);
    const impact = analyzeImpact(root, state.config, state.graph, state.index, state.ownership, state.contexts, {
      changes: [changed("src/payment.ts")],
      developerTeam: "checkout-team",
    });
    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    const review = resolveReviewers(root, state.config, impact.value);
    const decision = buildGovernanceDecision(impact.value, review, "enforce");
    expect(decision.outcome).toBe("block");
    expect(decision.shouldFail).toBe(true);
    expect(decision.affectedContexts[0]?.sourceFormat).toBe("lcdd-0.6");
    expect(decision.affectedContexts[0]?.enforcementMode).toBe("block");
  });

  it("converts legacy Contexts into valid LCDD 0.6 artifacts", () => {
    const root = fixtureRoot("cross-team");
    const loaded = loadContexts(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.warnings.some((warning) => warning.includes("Deprecated"))).toBe(true);
    for (const record of loaded.value.contexts) {
      const canonical = legacyToLcddContext(record);
      expect(validateContextFull(canonical)).toEqual({ valid: true, errors: [] });
    }
  });

  it("keeps canonical Contexts ahead of duplicate legacy records", () => {
    const root = tmpDir();
    copyFixture("lcdd-canonical", root);
    fs.mkdirSync(path.join(root, ".nodenet"), { recursive: true });
    fs.writeFileSync(path.join(root, ".nodenet", "context.json"), JSON.stringify({
      id: "PAYMENT-100",
      version: 1,
      title: "Legacy duplicate",
      type: "businessRule",
      status: "ACTIVE",
      authority: "GUIDELINE",
      approvalRequired: false,
      appliesTo: ["legacy/**"],
      approvedBy: [],
      provenance: {
        source: "test",
        createdBy: "test",
        createdAt: "2026-01-01T00:00:00.000Z",
        kind: "USER_DECLARED",
        evidence: [],
      },
    }));
    const loaded = loadContexts(root);
    expect(loaded.ok && loaded.value.contexts[0]?.sourceFormat).toBe("lcdd-0.6");
    expect(loaded.ok && loaded.value.contexts[0]?.title).toBe("Payment settlement authorization");
  });

  it("rejects symlinks before the LCDD Registry SDK can follow them", () => {
    const root = tmpDir();
    const outside = tmpDir();
    fs.mkdirSync(path.join(root, ".lcdd", "contexts"), { recursive: true });
    fs.writeFileSync(path.join(outside, "outside.yaml"), "id: OUTSIDE\n");
    fs.symlinkSync(outside, path.join(root, ".lcdd", "contexts", "escape"));
    const loaded = loadContexts(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.contexts).toEqual([]);
    expect(loaded.value.warnings.some((warning) => warning.includes("symlink"))).toBe(true);
  });
});
