#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli", "cli.js");
const outDir = path.join(root, "benchmark-results", "e2e", "latest");
fs.mkdirSync(outDir, { recursive: true });

run(process.execPath, [cli, "build"], root);
const scenarios = JSON.parse(fs.readFileSync(path.join(root, "e2e", "scenarios.json"), "utf8"));
const retrieval = scenarios.map((scenario) => evaluateRetrieval(scenario));
const mutations = [
  { id: "parser-change", file: "src/parser/polyglot.ts", symbol: "E2E_PARSER_CHANGE", expectedContext: "NN-LANG-001", expectedReviewer: "language-team" },
  { id: "mcp-security-change", file: "src/mcp/security.ts", symbol: "E2E_MCP_SECURITY_CHANGE", expectedContext: "NN-SEC-001", expectedReviewer: "security-team" },
  { id: "governance-change", file: "src/evaluation/benchmark.ts", symbol: "E2E_GOVERNANCE_CHANGE", expectedContext: "NN-GOV-001", expectedReviewer: "governance-team" },
];
const changeResults = mutations.map((scenario) => evaluateMutation(scenario));

const adversarial = run("npx", ["vitest", "run", "test/security.test.ts", "test/property.test.ts", "test/mcp-http.test.ts"], root, false);
const historical = run("npx", ["vitest", "run", "test/startup-platform.test.ts"], root, false);
const graphFile = path.join(outDir, "repository-graph.html");
run(process.execPath, [cli, "graph", "--output", graphFile], root);

const broadChars = authoredCorpusCharacters(root);
const result = {
  schemaVersion: "1",
  generatedAt: new Date().toISOString(),
  repository: "NodeNet self-dogfood",
  retrieval,
  retrievalSummary: summarizeRetrieval(retrieval),
  changes: changeResults,
  adversarial: { passed: adversarial.status === 0, command: "vitest security + property + MCP HTTP" },
  historicalReplay: { passed: historical.status === 0, command: "vitest startup-platform historical replay" },
  abPilot: {
    variantA: { policy: "broad authored-corpus read", estimatedTokens: Math.ceil(broadChars / 4) },
    variantB: { policy: "ask + bounded context", successfulTasks: retrieval.filter((item) => item.pass).length, tasks: retrieval.length, estimatedTokens: retrieval.reduce((sum, item) => sum + item.estimatedTokens, 0) },
  },
};
result.abPilot.variantB.tokenReduction = round(1 - result.abPilot.variantB.estimatedTokens / (result.abPilot.variantA.estimatedTokens * retrieval.length));
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2) + "\n");
fs.writeFileSync(path.join(outDir, "summary.md"), markdown(result));
fs.writeFileSync(path.join(outDir, "index.html"), html(result));
process.stdout.write(JSON.stringify(result, null, 2) + "\n");

function evaluateRetrieval(scenario) {
  const ask = jsonCommand([cli, "ask", scenario.question, "--limit", "30", "--json"], root);
  const fullAsk = jsonCommand([cli, "ask", scenario.question, "--limit", "30", "--full", "--json"], root);
  const context = jsonCommand([cli, "context", scenario.expectedFiles[0], "--detail", "evidence", "--no-cache", "--json"], root);
  const route = jsonCommand([cli, "context", scenario.expectedFiles[0], "--detail", "route", "--no-cache", "--json"], root);
  const selected = new Set(ask.recommendedFiles);
  const expected = new Set(scenario.expectedFiles);
  const useful = new Set([...scenario.expectedFiles, ...(scenario.supportingFiles ?? [])]);
  const trueFiles = [...expected].filter((file) => selected.has(file)).length;
  const contexts = new Set(context.livingContext.map((item) => item.id));
  const contextHits = scenario.mandatoryContexts.filter((id) => contexts.has(id)).length;
  const estimatedTokens = context.metrics?.estimatedTokens ?? Math.ceil(JSON.stringify(context).length / 4);
  const fileRecall = ratio(trueFiles, expected.size);
  const contextRecall = ratio(contextHits, scenario.mandatoryContexts.length);
  const ranked = [...fullAsk.primaryFiles, ...fullAsk.supportingFiles, ...fullAsk.expansionCandidates].map((item) => item.path);
  const filePrecision = ratio(trueFiles, selected.size);
  const routeContexts = new Set(route.livingContext.map((item) => item.id));
  const routeContextRecall = ratio(scenario.mandatoryContexts.filter((id) => routeContexts.has(id)).length, scenario.mandatoryContexts.length);
  const askRoutingPreserved = JSON.stringify(ask.recommendedFiles) === JSON.stringify(fullAsk.recommendedFiles);
  const pass = filePrecision >= 0.9 && fileRecall === 1 && contextRecall === 1 && routeContextRecall === 1 && askRoutingPreserved;
  return { id: scenario.id, split: scenario.split, expectedFiles: scenario.expectedFiles, supportingFiles: scenario.supportingFiles ?? [], selectedFiles: ask.recommendedFiles, filePrecision, usefulPrecision: ratio([...selected].filter((file) => useful.has(file)).length, selected.size), fileRecall, mandatoryContextRecall: contextRecall, routeMandatoryContextRecall: routeContextRecall, askRoutingPreserved, reciprocalRank: reciprocalRank(ranked, expected), ndcg: ndcg(ranked, expected, new Set(scenario.supportingFiles ?? [])), estimatedTokens, leanAskTokens: Math.ceil(Buffer.byteLength(JSON.stringify(ask)) / 4), fullAskTokens: Math.ceil(Buffer.byteLength(JSON.stringify(fullAsk)) / 4), routeTokens: route.metrics.emittedTokens, evidenceTokens: context.metrics.emittedTokens, pass };
}

function evaluateMutation(scenario) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `nodenet-e2e-${scenario.id}-`));
  try {
    fs.cpSync(root, temp, { recursive: true, filter: (source) => !excluded(source) });
    run("git", ["init", "-b", "main"], temp);
    run("git", ["config", "user.email", "e2e@nodenet.local"], temp);
    run("git", ["config", "user.name", "NodeNet E2E"], temp);
    run("git", ["add", "."], temp); run("git", ["commit", "-m", "self e2e baseline"], temp);
    run("git", ["switch", "-c", scenario.id], temp);
    fs.appendFileSync(path.join(temp, scenario.file), `\nexport const ${scenario.symbol} = true;\n`);
    run("git", ["add", scenario.file], temp); run("git", ["commit", "-m", scenario.id], temp);
    run(process.execPath, [cli, "build"], temp);
    const impact = jsonCommand([cli, "impact", "--base", "main", "--json"], temp);
    const reviewers = jsonCommand([cli, "reviewers", "--base", "main", "--json"], temp);
    const contexts = new Set(impact.affectedContexts.map((item) => typeof item === "string" ? item : item.id));
    const approvalContexts = new Set(impact.directContexts ?? []);
    const reviewerTargets = [...reviewers.required, ...reviewers.authorityRequired].map((item) => item.target);
    const uniqueReviewers = [...new Set(reviewerTargets)].sort();
    const contextPrecision = ratio(approvalContexts.has(scenario.expectedContext) ? 1 : 0, approvalContexts.size);
    const reviewerPrecision = ratio(uniqueReviewers.includes(scenario.expectedReviewer) ? 1 : 0, uniqueReviewers.length);
    const pass = impact.changedFiles.includes(scenario.file) && approvalContexts.has(scenario.expectedContext) && uniqueReviewers.includes(scenario.expectedReviewer) && contextPrecision >= 0.9 && reviewerPrecision >= 0.9;
    return { id: scenario.id, changedFileDetected: impact.changedFiles.includes(scenario.file), severity: impact.severity, affectedFiles: impact.affectedFiles.length, blastContexts: [...contexts], approvalContexts: [...approvalContexts], contextPrecision, reviewers: uniqueReviewers, reviewerPrecision, informationalReviewers: reviewers.informational.map((item) => item.target), expectedContext: scenario.expectedContext, expectedReviewer: scenario.expectedReviewer, blastRadiusWarning: impact.affectedFiles.length > 50, pass };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function excluded(source) {
  const rel = path.relative(root, source).split(path.sep);
  return rel.some((part) => [".git", "node_modules", "dist", ".nodenet", "benchmark-results"].includes(part));
}
function jsonCommand(args, cwd) { return JSON.parse(run(process.execPath, args, cwd).stdout); }
function run(command, args, cwd, fail = true) { const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }); if (fail && result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`); return result; }
function ratio(n, d) { return d === 0 ? 1 : round(n / d); }
function mean(items, field) { return items.length ? round(items.reduce((sum, item) => sum + item[field], 0) / items.length) : 0; }
function summarizeRetrieval(items) { const summarize = rows => ({ cases: rows.length, primaryPrecision: mean(rows, "filePrecision"), essentialRecall: mean(rows, "fileRecall"), usefulPrecision: mean(rows, "usefulPrecision"), mandatoryContextRecall: mean(rows, "mandatoryContextRecall"), mrr: mean(rows, "reciprocalRank"), ndcg: mean(rows, "ndcg"), gatesPassed: rows.filter(row => row.pass).length }); return { overall: summarize(items), training: summarize(items.filter(item => item.split === "training")), holdout: summarize(items.filter(item => item.split === "holdout")) }; }
function reciprocalRank(ranked, essential) { const index = ranked.findIndex((file) => essential.has(file)); return index < 0 ? 0 : round(1 / (index + 1)); }
function ndcg(ranked, essential, supporting) { const gains = ranked.slice(0, 10).map((file) => essential.has(file) ? 3 : supporting.has(file) ? 1 : 0); const dcg = gains.reduce((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0); const ideal = [...Array(essential.size).fill(3), ...Array(supporting.size).fill(1)].slice(0, 10).reduce((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0); return ideal === 0 ? 1 : round(dcg / ideal); }
function round(value) { return Number(value.toFixed(4)); }
function authoredCorpusCharacters(directory) { let total = 0; const stack = [directory]; while (stack.length) { const current = stack.pop(); for (const entry of fs.readdirSync(current, { withFileTypes: true })) { if ([".git", "node_modules", "dist", ".nodenet", "benchmark-results"].includes(entry.name)) continue; const absolute = path.join(current, entry.name); if (entry.isDirectory()) stack.push(absolute); else if (/\.(?:ts|js|mjs|json|md|ya?ml|sql|tf|svg)$/i.test(entry.name)) total += fs.statSync(absolute).size; } } return total; }
function markdown(r) { return `# NodeNet self-repository E2E\n\nGenerated: ${r.generatedAt}\n\n- Retrieval: ${r.retrieval.filter(x => x.pass).length}/${r.retrieval.length} passed.\n- Overall primary precision / essential recall: ${pct(r.retrievalSummary.overall.primaryPrecision)} / ${pct(r.retrievalSummary.overall.essentialRecall)}.\n- Holdout primary precision / essential recall: ${pct(r.retrievalSummary.holdout.primaryPrecision)} / ${pct(r.retrievalSummary.holdout.essentialRecall)}.\n- Holdout MRR / nDCG@10: ${r.retrievalSummary.holdout.mrr} / ${r.retrievalSummary.holdout.ndcg}.\n- Real-code mutation impact: ${r.changes.filter(x => x.pass).length}/${r.changes.length} passed.\n- Adversarial suite: ${r.adversarial.passed ? "passed" : "failed"}.\n- Historical replay suite: ${r.historicalReplay.passed ? "passed" : "failed"}.\n- Deterministic A/B token reduction: ${(r.abPilot.variantB.tokenReduction * 100).toFixed(1)}%.\n\nSee results.json for case-level evidence and repository-graph.html for the generated graph.\n`; }
function html(r) { const rows = r.retrieval.map(x => `<tr><td>${escape(x.id)}</td><td>${pct(x.filePrecision)}</td><td>${pct(x.fileRecall)}</td><td>${pct(x.mandatoryContextRecall)}</td><td>${x.estimatedTokens}</td><td>${status(x.pass)}</td></tr>`).join(""); const changes = r.changes.map(x => `<tr><td>${escape(x.id)}</td><td>${escape(x.severity)}</td><td>${x.affectedFiles}</td><td>${pct(x.contextPrecision)}</td><td>${pct(x.reviewerPrecision)}</td><td>${x.blastRadiusWarning ? '<strong class="fail">BLAST WARN</strong>' : status(x.pass)}</td></tr>`).join(""); return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NodeNet self E2E</title><style>body{font:15px system-ui;margin:0;background:#0b1020;color:#e8ecf7}main{max-width:1100px;margin:auto;padding:32px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card,section{background:#151d32;border:1px solid #2b3858;border-radius:12px;padding:18px;margin:16px 0}.value{font-size:28px;font-weight:700;color:#79d7ff}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-bottom:1px solid #2b3858}th{color:#9fb0d1}.pass{color:#64e6a5}.fail{color:#ffb454}a{color:#79d7ff}@media(max-width:700px){table{font-size:12px}main{padding:14px}}</style></head><body><main><h1>NodeNet self-repository E2E</h1><p>${escape(r.generatedAt)}</p><div class="grid"><div class="card"><div>Retrieval gates</div><div class="value">${r.retrieval.filter(x=>x.pass).length}/${r.retrieval.length}</div></div><div class="card"><div>Reviewer precision gates</div><div class="value">${r.changes.filter(x=>x.pass).length}/${r.changes.length}</div></div><div class="card"><div>A/B token reduction</div><div class="value">${pct(r.abPilot.variantB.tokenReduction)}</div></div><div class="card"><div>Blast-radius warnings</div><div class="value">${r.changes.filter(x=>x.blastRadiusWarning).length}</div></div></div><section><h2>Retrieval evidence</h2><table><thead><tr><th>Task</th><th>Precision</th><th>Recall</th><th>Context</th><th>Tokens</th><th>Gate</th></tr></thead><tbody>${rows}</tbody></table></section><section><h2>Real-code Git mutations</h2><table><thead><tr><th>Scenario</th><th>Severity</th><th>Blast files</th><th>Approval-context precision</th><th>Required-reviewer precision</th><th>Blast radius</th></tr></thead><tbody>${changes}</tbody></table></section><section><h2>Artifacts</h2><p><a href="repository-graph.html">Open interactive repository graph</a> · <a href="results.json">Raw JSON evidence</a></p></section></main></body></html>`; }
function pct(v) { return `${(v * 100).toFixed(1)}%`; }
function status(v) { return `<strong class="${v ? "pass" : "fail"}">${v ? "PASS" : "FAIL"}</strong>`; }
function escape(v) { return String(v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
