#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const input = process.argv[2];
if (!input) fail("usage: node scripts/score-governed-change-ab.mjs <results.json>");
const file = path.resolve(input);
const experiment = JSON.parse(fs.readFileSync(file, "utf8"));
if (experiment.schemaVersion !== "1" || experiment.experiment !== "governed-change-ab" || !Array.isArray(experiment.pairs)) {
  fail("invalid governed-change A/B result document");
}

const pairs = experiment.pairs.map(validatePair);
const indexing = validateIndexing(experiment.indexing ?? {});
const control = summarize(pairs.map((pair) => pair.control));
const treatment = summarize(pairs.map((pair) => pair.treatment));
const tokenDeltas = pairs.map((pair) => taskTokens(pair.treatment) - taskTokens(pair.control));
const elapsedDeltas = pairs.map((pair) => pair.treatment.elapsedMs - pair.control.elapsedMs);
const irrelevantDeltas = pairs.map((pair) => pair.treatment.irrelevantFilesRead - pair.control.irrelevantFilesRead);
const tokenCi = bootstrapMedianCi(tokenDeltas);
const qualityGates = {
  minimumPairs: pairs.length >= 10,
  taskSuccessNonInferior: treatment.taskSuccessRate - control.taskSuccessRate >= -0.02,
  mandatoryContextRecall: treatment.mandatoryContextRecall === 1,
  reviewerRecall: treatment.reviewerRecall === 1,
  forbiddenChanges: treatment.forbiddenChanges === 0,
  governanceViolations: treatment.governanceViolations === 0,
  irrelevantReadsNonInferior: median(irrelevantDeltas) <= 0,
};
const qualityPassed = Object.values(qualityGates).every(Boolean);
const tokenSavingPublishable = qualityPassed && tokenCi.high < 0;
const indexingTokens = indexing.inputTokens + indexing.outputTokens;

const result = {
  schemaVersion: "1",
  source: file,
  pairs: pairs.length,
  control,
  treatment,
  pairedDeltas: {
    medianTaskTokens: median(tokenDeltas),
    medianElapsedMs: median(elapsedDeltas),
    medianIrrelevantFilesRead: median(irrelevantDeltas),
    taskTokenBootstrap95: tokenCi,
  },
  treatmentTokenViews: {
    medianTaskTokens: treatment.medianTaskTokens,
    medianColdTotalTokens: treatment.medianTaskTokens + indexingTokens,
    medianAmortizedTotalTokens: treatment.medianTaskTokens + Math.ceil(indexingTokens / indexing.reuseCount),
    indexingTokens,
    indexingReuseCount: indexing.reuseCount,
  },
  gates: qualityGates,
  qualityPassed,
  tokenSavingPublishable,
  permittedClaim: tokenSavingPublishable
    ? "NodeNet reduced median provider task tokens in this paired experiment while passing all quality and governance gates."
    : qualityPassed
      ? "NodeNet passed safe-change quality gates; token saving is not statistically established."
      : "No public efficiency claim: one or more safe-change quality gates failed.",
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exit(qualityPassed ? 0 : 2);

function validatePair(value, index) {
  if (!value || typeof value !== "object" || typeof value.taskId !== "string") fail(`pair ${index} requires taskId`);
  return { taskId: value.taskId, control: validateRun(value.control, index, "control"), treatment: validateRun(value.treatment, index, "treatment") };
}

function validateRun(value, index, condition) {
  if (!value || typeof value !== "object") fail(`pair ${index} ${condition} must be an object`);
  const booleans = ["taskSuccess", "regressionSuccess", "severityCorrect"];
  const numbers = ["inputTokens", "cachedInputTokens", "outputTokens", "elapsedMs", "toolCalls", "filesRead", "irrelevantFilesRead", "repairTurns", "mandatoryContextRecall", "reviewerPrecision", "reviewerRecall", "forbiddenChanges", "governanceViolations"];
  for (const key of booleans) if (typeof value[key] !== "boolean") fail(`pair ${index} ${condition}.${key} must be boolean`);
  for (const key of numbers) if (typeof value[key] !== "number" || value[key] < 0) fail(`pair ${index} ${condition}.${key} must be a non-negative number`);
  for (const key of ["mandatoryContextRecall", "reviewerPrecision", "reviewerRecall"]) if (value[key] > 1) fail(`pair ${index} ${condition}.${key} must be <= 1`);
  return value;
}

function validateIndexing(value) {
  const inputTokens = nonnegative(value.inputTokens, "indexing.inputTokens");
  const outputTokens = nonnegative(value.outputTokens, "indexing.outputTokens");
  const reuseCount = nonnegative(value.reuseCount, "indexing.reuseCount");
  if (reuseCount < 1) fail("indexing.reuseCount must be at least 1");
  return { inputTokens, outputTokens, reuseCount };
}

function nonnegative(value, name) {
  if (typeof value !== "number" || value < 0) fail(`${name} must be a non-negative number`);
  return value;
}

function summarize(runs) {
  return {
    taskSuccessRate: mean(runs.map((run) => Number(run.taskSuccess))),
    regressionSuccessRate: mean(runs.map((run) => Number(run.regressionSuccess))),
    medianTaskTokens: median(runs.map(taskTokens)),
    medianElapsedMs: median(runs.map((run) => run.elapsedMs)),
    medianToolCalls: median(runs.map((run) => run.toolCalls)),
    medianFilesRead: median(runs.map((run) => run.filesRead)),
    medianIrrelevantFilesRead: median(runs.map((run) => run.irrelevantFilesRead)),
    medianRepairTurns: median(runs.map((run) => run.repairTurns)),
    mandatoryContextRecall: mean(runs.map((run) => run.mandatoryContextRecall)),
    reviewerPrecision: mean(runs.map((run) => run.reviewerPrecision)),
    reviewerRecall: mean(runs.map((run) => run.reviewerRecall)),
    severityAccuracy: mean(runs.map((run) => Number(run.severityCorrect))),
    forbiddenChanges: sum(runs.map((run) => run.forbiddenChanges)),
    governanceViolations: sum(runs.map((run) => run.governanceViolations)),
  };
}

function taskTokens(run) { return run.inputTokens + run.cachedInputTokens + run.outputTokens; }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function mean(values) { return values.length ? round(sum(values) / values.length) : 0; }
function median(values) { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2); }
function round(value) { return Number(value.toFixed(4)); }

function bootstrapMedianCi(values) {
  if (!values.length) return { low: 0, high: 0, samples: 0 };
  let state = 0x4e4f4445;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 2 ** 32; };
  const samples = [];
  for (let iteration = 0; iteration < 10_000; iteration++) {
    const resample = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]);
    samples.push(median(resample));
  }
  samples.sort((a, b) => a - b);
  return { low: samples[249], high: samples[9749], samples: samples.length };
}

function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
