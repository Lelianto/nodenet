/** Engine-executed retrieval benchmark. Ground truth is labeled before running NodeNet. */
import fs from "node:fs";
import type { Graph } from "../graph/graph.js";
import type { CodeGraphIndex } from "../analyzer/code-graph.js";
import type { OwnershipIndex } from "../ownership/resolver.js";
import type { ContextRecord } from "../context/schema.js";
import { askGraph } from "../ai/retrieval.js";
import { buildContextBundle, estimateTokens } from "../ai/context-builder.js";

export interface RetrievalBenchmarkCase {
  id: string;
  question: string;
  expectedFiles: string[];
  supportingFiles?: string[];
  mandatoryContexts: string[];
  rawBaselineTokens: number;
  maxTokens?: number;
}
export interface RetrievalCaseResult {
  id: string; queryId: string; selectedFiles: string[]; filePrecision: number; fileRecall: number; usefulPrecision: number; reciprocalRank: number; ndcg: number;
  mandatoryContextRecall: number; estimatedTokens: number; emittedTokens: number; tokenReduction: number; emittedTokenReduction: number; truncated: boolean;
}
export interface RetrievalBenchmarkReport {
  cases: number; medianTokenReduction: number; medianEmittedTokenReduction: number; meanFilePrecision: number; meanFileRecall: number;
  meanUsefulPrecision: number; meanReciprocalRank: number; meanNdcg: number; mandatoryContextRecall: number; results: RetrievalCaseResult[];
}

/**
 * Tokens for the compact UTF-8 payload emitted by current CLI and MCP defaults.
 */
export function estimateEmittedTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4);
}

export function loadRetrievalBenchmark(file: string): RetrievalBenchmarkCase[] {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error("Retrieval benchmark must be a JSON array.");
  return value.map((item, index) => validate(item, index));
}

export function runRetrievalBenchmark(root: string, state: { graph: Graph; index: CodeGraphIndex; ownership: OwnershipIndex; contexts: ContextRecord[] }, cases: RetrievalBenchmarkCase[]): RetrievalBenchmarkReport {
  const results = cases.map((item): RetrievalCaseResult => {
    const ask = askGraph(state.graph, item.question, 30);
    const target = ask.primaryFiles[0]?.path ?? ask.matches[0]?.id ?? item.question;
    const bundle = buildContextBundle(state.graph, state.index, state.ownership, state.contexts, target, { maxTokens: item.maxTokens ?? 2_000, detail: "evidence", root });
    const selectedFiles = ask.recommendedFiles;
    const expected = new Set(item.expectedFiles);
    const useful = new Set([...item.expectedFiles, ...(item.supportingFiles ?? [])]);
    const selected = new Set(selectedFiles);
    const trueFiles = [...selected].filter((file) => expected.has(file)).length;
    const actualContexts = new Set(bundle?.livingContext.map((context) => context.id) ?? []);
    const trueContexts = item.mandatoryContexts.filter((id) => actualContexts.has(id)).length;
    const estimatedTokens = bundle ? estimateTokens(bundle) : estimateTokens(ask);
    const emittedTokens = bundle ? estimateEmittedTokens(bundle) : estimateEmittedTokens(ask);
    return {
      id: item.id, queryId: ask.queryId, selectedFiles,
      filePrecision: ratio(trueFiles, selected.size), fileRecall: ratio(trueFiles, expected.size), usefulPrecision: ratio([...selected].filter((file) => useful.has(file)).length, selected.size),
      reciprocalRank: reciprocalRank([...ask.primaryFiles, ...ask.supportingFiles, ...ask.expansionCandidates].map((file) => file.path), expected),
      ndcg: ndcg([...ask.primaryFiles, ...ask.supportingFiles, ...ask.expansionCandidates].map((file) => file.path), expected, new Set(item.supportingFiles ?? [])),
      mandatoryContextRecall: ratio(trueContexts, item.mandatoryContexts.length), estimatedTokens, emittedTokens,
      tokenReduction: Number((1 - estimatedTokens / item.rawBaselineTokens).toFixed(4)),
      emittedTokenReduction: Number((1 - emittedTokens / item.rawBaselineTokens).toFixed(4)), truncated: bundle?.metrics.truncated ?? false,
    };
  });
  return {
    cases: results.length,
    medianTokenReduction: percentile(results.map((item) => item.tokenReduction), 0.5),
    medianEmittedTokenReduction: percentile(results.map((item) => item.emittedTokenReduction), 0.5),
    meanFilePrecision: mean(results.map((item) => item.filePrecision)),
    meanFileRecall: mean(results.map((item) => item.fileRecall)),
    meanUsefulPrecision: mean(results.map((item) => item.usefulPrecision)),
    meanReciprocalRank: mean(results.map((item) => item.reciprocalRank)),
    meanNdcg: mean(results.map((item) => item.ndcg)),
    mandatoryContextRecall: ratio(results.reduce((sum, item) => sum + item.mandatoryContextRecall, 0), results.length),
    results,
  };
}

function validate(value: unknown, index: number): RetrievalBenchmarkCase {
  if (!value || typeof value !== "object") throw new Error(`Retrieval case ${index} must be an object.`);
  const item = value as Record<string, unknown>;
  if (typeof item["id"] !== "string" || typeof item["question"] !== "string") throw new Error(`Retrieval case ${index} requires id and question.`);
  if (!Array.isArray(item["expectedFiles"]) || !Array.isArray(item["mandatoryContexts"])) throw new Error(`Retrieval case ${index} requires expectedFiles and mandatoryContexts arrays.`);
  if (typeof item["rawBaselineTokens"] !== "number" || item["rawBaselineTokens"] <= 0) throw new Error(`Retrieval case ${index} requires positive rawBaselineTokens.`);
  return { id: item["id"], question: item["question"], expectedFiles: item["expectedFiles"].filter((x): x is string => typeof x === "string"), ...(Array.isArray(item["supportingFiles"]) ? { supportingFiles: item["supportingFiles"].filter((x): x is string => typeof x === "string") } : {}), mandatoryContexts: item["mandatoryContexts"].filter((x): x is string => typeof x === "string"), rawBaselineTokens: item["rawBaselineTokens"], ...(typeof item["maxTokens"] === "number" ? { maxTokens: item["maxTokens"] } : {}) };
}
function reciprocalRank(ranked: string[], essential: Set<string>): number { const index = ranked.findIndex((file) => essential.has(file)); return index < 0 ? 0 : Number((1 / (index + 1)).toFixed(4)); }
function ndcg(ranked: string[], essential: Set<string>, supporting: Set<string>): number { const gains: number[] = ranked.slice(0, 10).map((file) => essential.has(file) ? 3 : supporting.has(file) ? 1 : 0); const dcg = gains.reduce<number>((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0); const ideal: number[] = [...Array(essential.size).fill(3), ...Array(supporting.size).fill(1)].slice(0, 10); const idealDcg = ideal.reduce<number>((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0); return idealDcg === 0 ? 1 : Number((dcg / idealDcg).toFixed(4)); }
function ratio(n: number, d: number): number { return d === 0 ? 1 : Number((n / d).toFixed(4)); }
function mean(values: number[]): number { return values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4)) : 0; }
function percentile(values: number[], fraction: number): number { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0; }
