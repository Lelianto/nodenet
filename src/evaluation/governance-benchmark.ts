/** Executes NodeNet for each labeled git base instead of accepting hard-coded actual results. */
import fs from "node:fs";
import type { LoadedConfig } from "../config/config.js";
import type { AnalysisState } from "../types/analysis-state.js";
import { analyzeImpact } from "../change/impact.js";
import { resolveReviewers } from "../review/resolver.js";
import { buildGovernanceDecision, type GovernanceMode, type GovernanceOutcome } from "../governance/decision.js";
import { scoreBenchmark, type BenchmarkMetrics, type LabeledDecisionCase } from "./benchmark.js";

export interface ExecutableGovernanceCase {
  id: string; base: string; expectedOutcome: GovernanceOutcome; expectedReviewers: string[];
  hardenedImpactExpected?: boolean; mode?: GovernanceMode;
}
export interface GovernanceBenchmarkReport { metrics: BenchmarkMetrics; cases: LabeledDecisionCase[]; errors: Array<{ id: string; error: string }> }

export function loadExecutableGovernanceCases(file: string): ExecutableGovernanceCase[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("Executable governance benchmark must be a JSON array.");
  return raw.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`Governance case ${index} must be an object.`);
    const item = value as Record<string, unknown>;
    if (typeof item["id"] !== "string" || typeof item["base"] !== "string") throw new Error(`Governance case ${index} requires id and base.`);
    if (!["pass", "warn", "block"].includes(String(item["expectedOutcome"]))) throw new Error(`Governance case ${index} has invalid expectedOutcome.`);
    if (!Array.isArray(item["expectedReviewers"])) throw new Error(`Governance case ${index} requires expectedReviewers.`);
    return { id: item["id"], base: item["base"], expectedOutcome: item["expectedOutcome"] as GovernanceOutcome, expectedReviewers: item["expectedReviewers"].filter((x): x is string => typeof x === "string"), ...(typeof item["hardenedImpactExpected"] === "boolean" ? { hardenedImpactExpected: item["hardenedImpactExpected"] } : {}), ...(["observe", "warn", "enforce"].includes(String(item["mode"])) ? { mode: item["mode"] as GovernanceMode } : {}) };
  });
}

export function runGovernanceBenchmark(root: string, config: LoadedConfig, state: AnalysisState, definitions: ExecutableGovernanceCase[]): GovernanceBenchmarkReport {
  const cases: LabeledDecisionCase[] = [];
  const errors: GovernanceBenchmarkReport["errors"] = [];
  for (const definition of definitions) {
    const started = performance.now();
    const impact = analyzeImpact(root, config, state.graph, state.index, state.ownership, state.contexts, { base: definition.base });
    if (!impact.ok) { errors.push({ id: definition.id, error: impact.error.message }); continue; }
    const reviewers = resolveReviewers(root, config, impact.value);
    const decision = buildGovernanceDecision(impact.value, reviewers, definition.mode ?? "warn");
    const actualReviewers = [...new Set([...reviewers.required, ...reviewers.authorityRequired].map((item) => item.target))].sort();
    cases.push({ id: definition.id, expectedOutcome: definition.expectedOutcome, actualOutcome: decision.outcome, expectedReviewers: definition.expectedReviewers, actualReviewers, durationMs: Math.round(performance.now() - started), ...(definition.hardenedImpactExpected !== undefined ? { hardenedImpactExpected: definition.hardenedImpactExpected, hardenedImpactDetected: impact.value.affectedContexts.some((context) => context.authority === "HARDENED" || context.authority === "MANDATORY") } : {}) });
  }
  return { metrics: scoreBenchmark(cases), cases, errors };
}
