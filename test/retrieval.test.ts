import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { askGraph, affectedByTarget } from "../src/ai/retrieval.js";
import { buildContextBundle } from "../src/ai/context-builder.js";
import { appendRetrievalFeedback } from "../src/ai/feedback.js";
import { contextCacheKey, readContextCache, writeContextCache } from "../src/ai/context-cache.js";
import { runRetrievalBenchmark } from "../src/evaluation/retrieval-benchmark.js";
import { buildFixtureState, copyFixture, tmpDir } from "./helpers.js";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(): { root: string; state: ReturnType<typeof buildFixtureState> } {
  const dir = tmpDir(); dirs.push(dir);
  const root = path.join(dir, "repo"); copyFixture("cross-team", root);
  return { root, state: buildFixtureState(root) };
}

describe("token-efficient retrieval", () => {
  it("answers intent-aware questions and computes hypothetical affected nodes", () => {
    const { state } = fixture();
    const ask = askGraph(state.graph, "what connects checkout to payment", 20);
    expect(ask.matches.length).toBeGreaterThan(0);
    expect(ask.recommendedFiles.some((file) => file.includes("checkout") || file.includes("payment"))).toBe(true);
    expect(ask.primaryFiles.length).toBeLessThanOrEqual(2);
    expect(ask.recommendedFiles).toEqual(ask.primaryFiles.map((file) => file.path));
    expect(new Set([...ask.primaryFiles, ...ask.supportingFiles].map((file) => file.path)).size).toBe(ask.primaryFiles.length + ask.supportingFiles.length);
    const affected = affectedByTarget(state.graph, state.config, "PaymentService", 2);
    expect(affected?.affected.length).toBeGreaterThan(0);
  });

  it("returns bounded secret-scanned source evidence", () => {
    const { root, state } = fixture();
    const bundle = buildContextBundle(state.graph, state.index, state.ownership, state.contexts, "createSettlement", { detail: "source", root, maxTokens: 4_000 });
    expect(bundle?.sourceEvidence.length).toBeGreaterThan(0);
    expect(bundle?.sourceEvidence.every((item) => item.endLine - item.startLine <= 10)).toBe(true);
  });

  it("resolves an explicit file path before fuzzy symbol matches", () => {
    const { state } = fixture();
    const bundle = buildContextBundle(state.graph, state.index, state.ownership, state.contexts, "src/payment/PaymentService.ts", { detail: "evidence" });
    expect(bundle?.target).toBe("src/payment/PaymentService.ts");
    expect(bundle?.livingContext.map((context) => context.id)).toEqual(expect.arrayContaining(["PAYMENT-003", "SEC-009"]));
  });

  it("caches only source-free bundles and records opt-in feedback", () => {
    const { root, state } = fixture();
    const options = { detail: "evidence" as const };
    const bundle = buildContextBundle(state.graph, state.index, state.ownership, state.contexts, "createSettlement", options)!;
    const key = contextCacheKey({ graphBuiltAt: state.graph.metadata.builtAt, target: "createSettlement", options, contextFingerprint: "fixture" });
    writeContextCache(root, key, bundle);
    expect(readContextCache(root, key)?.target).toBe(bundle.target);
    const feedback = appendRetrievalFeedback(root, { queryId: "aabbccddeeff00112233", outcome: "useful" });
    expect(feedback.outcome).toBe("useful");
    expect(fs.existsSync(path.join(root, ".nodenet", "retrieval-feedback.jsonl"))).toBe(true);
  });

  it("executes labeled retrieval cases against the real graph", () => {
    const { root, state } = fixture();
    const report = runRetrievalBenchmark(root, state, [{ id: "payment", question: "payment settlement", expectedFiles: ["src/payment/PaymentService.ts"], mandatoryContexts: ["PAYMENT-003", "SEC-009"], rawBaselineTokens: 10_000 }]);
    expect(report.cases).toBe(1);
    expect(report.results[0]?.estimatedTokens).toBeGreaterThan(0);
    expect(report.results[0]?.tokenReduction).toBeGreaterThan(0);
    expect(report.results[0]?.reciprocalRank).toBeGreaterThan(0);
    expect(report.results[0]?.ndcg).toBeGreaterThan(0);
  });
});
