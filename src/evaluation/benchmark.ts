import fs from "node:fs";
import type { GovernanceOutcome } from "../governance/decision.js";

export interface LabeledDecisionCase {
  id: string;
  expectedOutcome: GovernanceOutcome;
  actualOutcome: GovernanceOutcome;
  expectedReviewers: string[];
  actualReviewers: string[];
  durationMs: number;
  hardenedImpactExpected?: boolean;
  hardenedImpactDetected?: boolean;
}

export interface BenchmarkMetrics {
  cases: number;
  reviewerPrecision: number;
  reviewerRecall: number;
  falseBlockRate: number;
  missedImpactRate: number;
  outcomeAccuracy: number;
  p50Ms: number;
  p95Ms: number;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

export function scoreBenchmark(cases: LabeledDecisionCase[]): BenchmarkMetrics {
  let trueReviewers = 0;
  let predictedReviewers = 0;
  let expectedReviewers = 0;
  let falseBlocks = 0;
  let nonBlockingExpected = 0;
  let missedHardened = 0;
  let hardenedExpected = 0;
  let correctOutcomes = 0;
  for (const item of cases) {
    const expected = new Set(item.expectedReviewers);
    const actual = new Set(item.actualReviewers);
    expectedReviewers += expected.size;
    predictedReviewers += actual.size;
    for (const reviewer of actual) if (expected.has(reviewer)) trueReviewers += 1;
    if (item.expectedOutcome !== "block") {
      nonBlockingExpected += 1;
      if (item.actualOutcome === "block") falseBlocks += 1;
    }
    if (item.hardenedImpactExpected) {
      hardenedExpected += 1;
      if (!item.hardenedImpactDetected) missedHardened += 1;
    }
    if (item.expectedOutcome === item.actualOutcome) correctOutcomes += 1;
  }
  return {
    cases: cases.length,
    reviewerPrecision: ratio(trueReviewers, predictedReviewers),
    reviewerRecall: ratio(trueReviewers, expectedReviewers),
    falseBlockRate: ratio(falseBlocks, nonBlockingExpected),
    missedImpactRate: ratio(missedHardened, hardenedExpected),
    outcomeAccuracy: ratio(correctOutcomes, cases.length),
    p50Ms: percentile(cases.map((item) => item.durationMs), 0.5),
    p95Ms: percentile(cases.map((item) => item.durationMs), 0.95),
  };
}

export function loadBenchmarkCases(file: string): LabeledDecisionCase[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("Benchmark dataset must be a JSON array.");
  return raw.map((item, index) => validateCase(item, index));
}

function validateCase(value: unknown, index: number): LabeledDecisionCase {
  if (typeof value !== "object" || value === null) throw new Error(`Benchmark case ${index} must be an object.`);
  const item = value as Record<string, unknown>;
  const outcomes = ["pass", "warn", "block"];
  if (typeof item["id"] !== "string") throw new Error(`Benchmark case ${index} requires id.`);
  if (!outcomes.includes(String(item["expectedOutcome"])) || !outcomes.includes(String(item["actualOutcome"]))) {
    throw new Error(`Benchmark case ${index} has an invalid outcome.`);
  }
  if (!Array.isArray(item["expectedReviewers"]) || !Array.isArray(item["actualReviewers"])) {
    throw new Error(`Benchmark case ${index} requires reviewer arrays.`);
  }
  if (typeof item["durationMs"] !== "number" || item["durationMs"] < 0) {
    throw new Error(`Benchmark case ${index} requires a non-negative durationMs.`);
  }
  return {
    id: item["id"],
    expectedOutcome: item["expectedOutcome"] as GovernanceOutcome,
    actualOutcome: item["actualOutcome"] as GovernanceOutcome,
    expectedReviewers: item["expectedReviewers"].filter((x): x is string => typeof x === "string"),
    actualReviewers: item["actualReviewers"].filter((x): x is string => typeof x === "string"),
    durationMs: item["durationMs"],
    ...(typeof item["hardenedImpactExpected"] === "boolean" ? { hardenedImpactExpected: item["hardenedImpactExpected"] } : {}),
    ...(typeof item["hardenedImpactDetected"] === "boolean" ? { hardenedImpactDetected: item["hardenedImpactDetected"] } : {}),
  };
}
