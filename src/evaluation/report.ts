import type { GovernanceOutcome } from "../governance/decision.js";
import { scoreBenchmark, type BenchmarkMetrics, type LabeledDecisionCase } from "./benchmark.js";
import type { EvaluationLabel, EvaluationRun } from "./types.js";

export interface EvaluationReport {
  datasetId: string;
  runId: string;
  labeled: number;
  evaluated: number;
  errors: number;
  metrics: BenchmarkMetrics;
  cases: LabeledDecisionCase[];
}

export interface EvaluationThresholds {
  minPrecision?: number;
  minRecall?: number;
  maxFalseBlock?: number;
  maxMissedHardened?: number;
}

export function buildEvaluationReport(run: EvaluationRun, labels: EvaluationLabel[]): EvaluationReport {
  const byPr = new Map(labels.map((label) => [label.pullRequest, label]));
  const cases: LabeledDecisionCase[] = [];
  for (const result of run.cases) {
    const label = byPr.get(result.pullRequest);
    if (!label || !result.decision) continue;
    const actualReviewers = result.decision.requiredApprovals.map((item) => item.target);
    cases.push({
      id: `pr-${result.pullRequest}`,
      expectedOutcome: label.expectedOutcome,
      actualOutcome: result.decision.outcome as GovernanceOutcome,
      expectedReviewers: label.expectedReviewers,
      actualReviewers,
      durationMs: result.durationMs,
      hardenedImpactExpected: label.hardenedImpactExpected,
      hardenedImpactDetected: result.decision.affectedContexts.some((context) => context.authority === "HARDENED" || context.authority === "MANDATORY"),
    });
  }
  return { datasetId: run.datasetId, runId: run.id, labeled: labels.length, evaluated: cases.length, errors: run.cases.filter((item) => item.error).length, metrics: scoreBenchmark(cases), cases };
}

export function evaluationGate(report: EvaluationReport, thresholds: EvaluationThresholds): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (thresholds.minPrecision !== undefined && report.metrics.reviewerPrecision < thresholds.minPrecision) failures.push(`reviewer precision ${report.metrics.reviewerPrecision} < ${thresholds.minPrecision}`);
  if (thresholds.minRecall !== undefined && report.metrics.reviewerRecall < thresholds.minRecall) failures.push(`reviewer recall ${report.metrics.reviewerRecall} < ${thresholds.minRecall}`);
  if (thresholds.maxFalseBlock !== undefined && report.metrics.falseBlockRate > thresholds.maxFalseBlock) failures.push(`false block rate ${report.metrics.falseBlockRate} > ${thresholds.maxFalseBlock}`);
  if (thresholds.maxMissedHardened !== undefined && report.metrics.missedImpactRate > thresholds.maxMissedHardened) failures.push(`missed hardened rate ${report.metrics.missedImpactRate} > ${thresholds.maxMissedHardened}`);
  if (report.evaluated === 0) failures.push("no labeled replay results available");
  return { pass: failures.length === 0, failures };
}
