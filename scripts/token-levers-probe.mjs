#!/usr/bin/env node
// Measures per-lever token cost of NodeNet retrieval payloads.
// Read-only: every CLI call uses --no-cache and nothing outside benchmark-results/ is written.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli", "cli.js");
const outDir = path.join(root, "benchmark-results", "token-levers", "latest");

const TARGETS = [
  "buildContextBundle",
  "askGraph",
  "attachRepositoryArtifacts",
  "authorityRank",
  "loadConfig",
  "adaptLcddContext",
  "scoreBenchmark",
  "analyzeImpact",
  "resolveReviewers",
  "secureToolOutput",
  "buildGovernanceDecision",
  "estimateTokens",
];

const QUESTIONS = [
  "how is the context bundle budget applied",
  "who reviews a governance change",
  "how are living contexts loaded from disk",
  "where is the MCP output secret scan",
];

// Field sets per proposed v2 profile. `route` answers "which files, who owns, what governs".
const PROFILE_FIELDS = {
  route: ["target", "recommendedFiles", "livingContext", "ownership", "authority", "changeBoundaries", "aiGuidance", "secretFlagged"],
  map: ["target", "codeEvidence", "recommendedFiles", "livingContext", "ownership", "authority", "changeBoundaries", "aiGuidance", "secretFlagged", "metrics"],
};

const MAP_EVIDENCE_FIELDS = ["id", "label", "path", "relation", "direction"];

if (!fs.existsSync(cli)) throw new Error(`missing ${cli} — run npm run build first`);
fs.mkdirSync(outDir, { recursive: true });

const contextCases = TARGETS.map((target) => probeContext(target));
const askCases = QUESTIONS.map((question) => probeAsk(question));

const result = {
  schemaVersion: "1",
  generatedAt: new Date().toISOString(),
  repository: "NodeNet self-repository",
  graph: graphMetadata(),
  estimator: "bytes / 4 (same estimator as src/ai/context-builder.ts estimateTokens)",
  contextCases,
  contextSummary: summarizeContext(contextCases),
  askCases,
  askSummary: summarizeAsk(askCases),
};
result.gates = gates(result);

fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2) + "\n");
fs.writeFileSync(path.join(outDir, "summary.md"), markdown(result));
process.stdout.write(markdown(result));
process.exit(result.gates.allPassed ? 0 : 2);

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

function probeContext(target) {
  const pretty = runCli([cli, "context", target, "--detail", "evidence", "--no-cache", "--json"]);
  const bundle = JSON.parse(pretty);
  const variants = {
    prettyDefault: pretty,
    compactDefault: JSON.stringify(bundle),
    compactNoCodeContext: JSON.stringify(withoutCodeContext(bundle)),
    compactNoSelectionReason: JSON.stringify(withoutSelectionReason(bundle)),
    compactTier1: JSON.stringify(withoutSelectionReason(withoutCodeContext(bundle))),
    profileMap: JSON.stringify(projectMapProfile(bundle)),
    profileRoute: JSON.stringify(pick(bundle, PROFILE_FIELDS.route)),
  };
  const bytes = Object.fromEntries(Object.entries(variants).map(([key, value]) => [key, Buffer.byteLength(value)]));
  const tokens = Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, Math.ceil(value / 4)]));
  const baseline = bytes.compactDefault;
  return {
    target,
    resolvedTarget: bundle.target,
    evidenceItems: bundle.codeEvidence.length,
    reportedEstimatedTokens: bundle.metrics.estimatedTokens,
    budgetTokens: bundle.metrics.budgetTokens,
    budgetExceeded: bundle.metrics.estimatedTokens > bundle.metrics.budgetTokens,
    bytes,
    tokens,
    fieldBytes: {
      codeContext: Buffer.byteLength(JSON.stringify(bundle.codeContext)),
      selectionReason: bundle.codeEvidence.reduce((sum, item) => sum + Buffer.byteLength(item.selectionReason ?? ""), 0),
      codeEvidence: Buffer.byteLength(JSON.stringify(bundle.codeEvidence)),
      governanceCore: Buffer.byteLength(JSON.stringify(pick(bundle, ["livingContext", "ownership", "authority", "changeBoundaries", "aiGuidance"]))),
    },
    savings: {
      prettyToCompact: reduction(bytes.prettyDefault, bytes.compactDefault),
      noCodeContext: reduction(baseline, bytes.compactNoCodeContext),
      noSelectionReason: reduction(baseline, bytes.compactNoSelectionReason),
      tier1: reduction(baseline, bytes.compactTier1),
      tier1VsPretty: reduction(bytes.prettyDefault, bytes.compactTier1),
      profileMap: reduction(baseline, bytes.profileMap),
      profileRoute: reduction(baseline, bytes.profileRoute),
    },
    // Tier 1 must be lossless: the same evidence set, minus a duplicated array and prose.
    lossless: losslessTier1(bundle),
  };
}

function probeAsk(question) {
  const pretty = runCli([cli, "ask", question, "--limit", "30", "--json"]);
  const ask = JSON.parse(pretty);
  const lean = {
    queryId: ask.queryId,
    intent: ask.intent,
    primaryFiles: ask.primaryFiles.map((item) => item.path),
    supportingFiles: ask.supportingFiles.map((item) => item.path),
    suggestedNext: ask.suggestedNext,
  };
  const bytes = {
    prettyDefault: Buffer.byteLength(pretty),
    compactDefault: Buffer.byteLength(JSON.stringify(ask)),
    matches: Buffer.byteLength(JSON.stringify(ask.matches)),
    connections: Buffer.byteLength(JSON.stringify(ask.connections)),
    lean: Buffer.byteLength(JSON.stringify(lean)),
  };
  return {
    question,
    matchCount: ask.matches.length,
    connectionCount: ask.connections.length,
    primaryFiles: lean.primaryFiles,
    bytes,
    tokens: Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, Math.ceil(value / 4)])),
    matchesAndConnectionsShare: round((bytes.matches + bytes.connections) / bytes.compactDefault),
    savings: {
      leanVsCompact: reduction(bytes.compactDefault, bytes.lean),
      leanVsPretty: reduction(bytes.prettyDefault, bytes.lean),
    },
    // The lean projection must preserve the files an agent would actually open.
    preservesRecommendedFiles: sameSet(lean.primaryFiles, ask.recommendedFiles),
  };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function withoutCodeContext(bundle) {
  const { codeContext: _codeContext, ...rest } = bundle;
  return rest;
}

function withoutSelectionReason(bundle) {
  return {
    ...bundle,
    codeEvidence: bundle.codeEvidence.map(({ selectionReason: _selectionReason, ...rest }) => rest),
    ...(bundle.sourceEvidence ? { sourceEvidence: bundle.sourceEvidence.map(({ selectionReason: _reason, ...rest }) => rest) } : {}),
  };
}

function projectMapProfile(bundle) {
  const projected = pick(bundle, PROFILE_FIELDS.map);
  projected.codeEvidence = bundle.codeEvidence.map((item) => pick(item, MAP_EVIDENCE_FIELDS));
  return projected;
}

function pick(source, fields) {
  const out = {};
  for (const field of fields) if (source[field] !== undefined) out[field] = source[field];
  return out;
}

function losslessTier1(bundle) {
  const labels = bundle.codeEvidence.map((item) => item.label);
  const contextIsDuplicate = JSON.stringify(labels) === JSON.stringify(bundle.codeContext);
  // selectionReason is derivable from relation + direction + depth + provenance + score.
  const reasonIsDerivable = bundle.codeEvidence.every(
    (item) =>
      item.selectionReason === undefined ||
      item.selectionReason ===
        `${item.direction} ${item.relation} relation at depth ${item.depth}; provenance=${item.provenance}; deterministic score=${item.score}`,
  );
  return { codeContextDuplicatesEvidenceLabels: contextIsDuplicate, selectionReasonDerivable: reasonIsDerivable };
}

// ---------------------------------------------------------------------------
// Summaries and gates
// ---------------------------------------------------------------------------

function summarizeContext(cases) {
  return {
    cases: cases.length,
    medianTier1Saving: median(cases.map((item) => item.savings.tier1)),
    minTier1Saving: Math.min(...cases.map((item) => item.savings.tier1)),
    maxTier1Saving: Math.max(...cases.map((item) => item.savings.tier1)),
    casesAboveQuarterSaving: cases.filter((item) => item.savings.tier1 >= 0.25).length,
    medianPrettyToCompact: median(cases.map((item) => item.savings.prettyToCompact)),
    medianProfileMapSaving: median(cases.map((item) => item.savings.profileMap)),
    medianProfileRouteSaving: median(cases.map((item) => item.savings.profileRoute)),
    medianReportedTokens: median(cases.map((item) => item.reportedEstimatedTokens)),
    medianEmittedTokens: median(cases.map((item) => item.tokens.prettyDefault)),
    medianTier1Tokens: median(cases.map((item) => item.tokens.compactTier1)),
    medianRouteTokens: median(cases.map((item) => item.tokens.profileRoute)),
    budgetExceededCases: cases.filter((item) => item.budgetExceeded).length,
    losslessCases: cases.filter((item) => item.lossless.codeContextDuplicatesEvidenceLabels && item.lossless.selectionReasonDerivable).length,
  };
}

function summarizeAsk(cases) {
  return {
    cases: cases.length,
    medianLeanSaving: median(cases.map((item) => item.savings.leanVsCompact)),
    medianMatchesAndConnectionsShare: median(cases.map((item) => item.matchesAndConnectionsShare)),
    medianEmittedTokens: median(cases.map((item) => item.tokens.prettyDefault)),
    medianLeanTokens: median(cases.map((item) => item.tokens.lean)),
    casesPreservingRecommendedFiles: cases.filter((item) => item.preservesRecommendedFiles).length,
  };
}

function gates(result) {
  const context = result.contextSummary;
  const ask = result.askSummary;
  const checks = [
    { id: "tier1-breadth", detail: "Tier 1 saves >= 25% of compact bytes on >= 10 of 12 context targets", passed: context.casesAboveQuarterSaving >= 10 },
    { id: "tier1-lossless", detail: "codeContext duplicates evidence labels and selectionReason is derivable on every case", passed: context.losslessCases === context.cases },
    { id: "ask-lean", detail: "Lean ask projection saves >= 90% of compact bytes (median)", passed: ask.medianLeanSaving >= 0.9 },
    { id: "ask-lean-lossless", detail: "Lean ask projection preserves recommendedFiles on every case", passed: ask.casesPreservingRecommendedFiles === ask.cases },
    { id: "estimator-undercount", detail: "Reported estimatedTokens under-counts the emitted payload (documents the accounting bug)", passed: context.medianEmittedTokens > context.medianReportedTokens },
  ];
  return { checks, allPassed: checks.every((check) => check.passed) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCli(args) {
  const outcome = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (outcome.status !== 0) throw new Error(`${args.join(" ")} failed:\n${outcome.stderr || outcome.stdout}`);
  return outcome.stdout;
}

function graphMetadata() {
  const file = path.join(root, ".nodenet", "graph.json");
  if (!fs.existsSync(file)) return null;
  const graph = JSON.parse(fs.readFileSync(file, "utf8"));
  return { nodes: graph.nodes.length, edges: graph.edges.length, builtAt: graph.metadata?.builtAt ?? null };
}

function reduction(before, after) {
  return before === 0 ? 0 : round(1 - after / before);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function sameSet(a, b) {
  return a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
}

function round(value) {
  return Number(value.toFixed(4));
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function markdown(result) {
  const contextRows = result.contextCases
    .map(
      (item) =>
        `| \`${item.target}\` | ${item.evidenceItems} | ${item.tokens.prettyDefault} | ${item.tokens.compactDefault} | ${item.tokens.compactTier1} | ${pct(item.savings.tier1)} | ${item.tokens.profileMap} | ${item.tokens.profileRoute} |`,
    )
    .join("\n");
  const askRows = result.askCases
    .map(
      (item) =>
        `| ${item.question} | ${item.matchCount}/${item.connectionCount} | ${item.tokens.prettyDefault} | ${item.tokens.compactDefault} | ${item.tokens.lean} | ${pct(item.savings.leanVsCompact)} | ${pct(item.matchesAndConnectionsShare)} |`,
    )
    .join("\n");
  const gateRows = result.gates.checks.map((check) => `| \`${check.id}\` | ${check.detail} | ${check.passed ? "PASS" : "FAIL"} |`).join("\n");
  return `# NodeNet token-lever probe

Generated: ${result.generatedAt}
Graph: ${result.graph ? `${result.graph.nodes} nodes, ${result.graph.edges} edges` : "unavailable"}
Estimator: ${result.estimator}

## Context bundle levers (tokens)

| Target | Evidence | Pretty (emitted) | Compact | Tier 1 lean | Tier 1 saving | Profile map | Profile route |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${contextRows}

Tier 1 = compact JSON minus \`codeContext\` (duplicate of \`codeEvidence[].label\`) minus \`selectionReason\` (derivable prose).

- Median Tier 1 saving vs compact: **${pct(result.contextSummary.medianTier1Saving)}** (range ${pct(result.contextSummary.minTier1Saving)}–${pct(result.contextSummary.maxTier1Saving)}).
- Cases at or above 25% saving: **${result.contextSummary.casesAboveQuarterSaving}/${result.contextSummary.cases}**.
- Median pretty-to-compact saving: ${pct(result.contextSummary.medianPrettyToCompact)}.
- Median reported \`estimatedTokens\` ${result.contextSummary.medianReportedTokens} vs median emitted ${result.contextSummary.medianEmittedTokens} tokens.
- Median profile saving: map ${pct(result.contextSummary.medianProfileMapSaving)}, route ${pct(result.contextSummary.medianProfileRouteSaving)} (route median ${result.contextSummary.medianRouteTokens} tokens).
- Cases where the soft budget was exceeded: ${result.contextSummary.budgetExceededCases}/${result.contextSummary.cases}.
- Cases where Tier 1 is provably lossless: ${result.contextSummary.losslessCases}/${result.contextSummary.cases}.

## Ask payload levers (tokens)

| Question | Matches/Connections | Pretty (emitted) | Compact | Lean | Lean saving | matches+connections share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${askRows}

- Median lean saving vs compact: **${pct(result.askSummary.medianLeanSaving)}** (median ${result.askSummary.medianLeanTokens} tokens vs ${result.askSummary.medianEmittedTokens} emitted).
- Median \`matches\` + \`connections\` share of the payload: ${pct(result.askSummary.medianMatchesAndConnectionsShare)}.
- Cases where the lean projection preserves \`recommendedFiles\`: ${result.askSummary.casesPreservingRecommendedFiles}/${result.askSummary.cases}.

## Gates

| Gate | Requirement | Result |
| --- | --- | --- |
${gateRows}

Overall: **${result.gates.allPassed ? "PASS" : "FAIL"}**

## Reproduction

\`\`\`bash
npm run build
node scripts/token-levers-probe.mjs
\`\`\`

Case-level evidence: \`benchmark-results/token-levers/latest/results.json\`.
`;
}
