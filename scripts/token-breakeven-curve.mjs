#!/usr/bin/env node
// Measures the token break-even point between unaided repository reading and NodeNet retrieval
// across corpus sizes. Every corpus is copied to a temp directory first; source repositories are
// never mutated.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli", "cli.js");
const outDir = path.join(root, "benchmark-results", "token-breakeven", "latest");

const EXCLUDED = new Set([".git", "node_modules", "dist", ".nodenet", "benchmark-results", ".lcdd-cache"]);
const AUTHORED = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|cs|php|rs|rb|kt|json|md|ya?ml|sql|tf)$/i;
const TARGETS_PER_CORPUS = 5;
const CODE_KINDS = new Set(["function", "class", "method", "interface", "component"]);

// Root files every subset corpus needs so that governance and ownership resolve the same way.
const SUBSET_ROOT_FILES = ["nodenet.config.json", "package.json", "tsconfig.json", ".lcdd"];

// Subsets of the self-repository fill the medium band (roughly 150-700 nodes) that no real
// corpus on this machine occupies. Modules are chosen by size, smallest cluster first.
const SUBSET_SMALL = ["src/authority", "src/config", "src/context", "src/types", "src/utils", "src/identity", "src/index.ts", "src/version.ts"];
const SUBSET_MEDIUM = [...SUBSET_SMALL, "src/ai", "src/parser", "src/storage", "src/ownership"];
const SUBSET_LARGE = [...SUBSET_MEDIUM, "src/graph", "src/evaluation", "src/governance", "src/review", "src/change"];

const CORPORA = [
  { id: "fixture-basic-typescript", label: "Fixture: basic TypeScript", source: path.join(root, "test", "fixtures", "basic-typescript") },
  { id: "fixture-react-app", label: "Fixture: React app", source: path.join(root, "test", "fixtures", "react-app") },
  { id: "fixture-monorepo", label: "Fixture: monorepo", source: path.join(root, "test", "fixtures", "monorepo") },
  { id: "payments-demo", label: "Example: payments demo", source: path.join(root, "examples", "payments-demo") },
  { id: "subset-small", label: "Self subset: core types + context", source: root, subset: SUBSET_SMALL },
  { id: "subset-medium", label: "Self subset: + ai + parser", source: root, subset: SUBSET_MEDIUM },
  { id: "subset-large", label: "Self subset: + graph + governance", source: root, subset: SUBSET_LARGE },
  { id: "lcdd", label: "LCDD specification + implementation", source: path.resolve(root, "..", "living-context-driven-development") },
  { id: "nodenet-self", label: "NodeNet self-repository", source: root },
];

if (!fs.existsSync(cli)) throw new Error(`missing ${cli} — run npm run build first`);
fs.mkdirSync(outDir, { recursive: true });

const corpora = [];
for (const corpus of CORPORA) {
  if (!fs.existsSync(corpus.source)) {
    corpora.push({ ...corpus, skipped: "source directory not present" });
    process.stderr.write(`skip ${corpus.id}: source directory not present\n`);
    continue;
  }
  process.stderr.write(`measuring ${corpus.id}...\n`);
  corpora.push(measureCorpus(corpus));
}

const measured = corpora.filter((corpus) => !corpus.skipped && corpus.targets.length > 0).sort((a, b) => a.graph.nodes - b.graph.nodes);
const result = {
  schemaVersion: "1",
  generatedAt: new Date().toISOString(),
  estimator: "bytes / 4 (same estimator as src/ai/context-builder.ts estimateTokens)",
  baselines: {
    greppedRead: "sum of bytes of every authored file containing the target identifier — the cost of reading each grep candidate",
    bestCaseRead: "bytes of the single file that defines the target — a perfect-luck unaided agent",
  },
  variants: {
    defaultEmitted: "current NodeNet output: context --detail evidence --json (pretty-printed, as actually emitted)",
    tier1Lean: "compact JSON minus codeContext and selectionReason",
    profileRoute: "proposed route profile: files + ownership + governance, no code evidence",
  },
  corpora: corpora.map((corpus) => (corpus.skipped ? corpus : { ...corpus, targets: corpus.targets })),
  curve: measured.map((corpus) => ({
    id: corpus.id,
    label: corpus.label,
    nodes: corpus.graph.nodes,
    authoredFiles: corpus.authored.files,
    greppedReadTokens: corpus.summary.greppedReadTokens,
    bestCaseReadTokens: corpus.summary.bestCaseReadTokens,
    defaultEmittedTokens: corpus.summary.defaultEmittedTokens,
    tier1LeanTokens: corpus.summary.tier1LeanTokens,
    profileRouteTokens: corpus.summary.profileRouteTokens,
    defaultWins: corpus.summary.defaultEmittedTokens < corpus.summary.greppedReadTokens,
    tier1Wins: corpus.summary.tier1LeanTokens < corpus.summary.greppedReadTokens,
    routeWins: corpus.summary.profileRouteTokens < corpus.summary.greppedReadTokens,
    defaultWinsBestCase: corpus.summary.defaultEmittedTokens < corpus.summary.bestCaseReadTokens,
    tier1WinsBestCase: corpus.summary.tier1LeanTokens < corpus.summary.bestCaseReadTokens,
    routeWinsBestCase: corpus.summary.profileRouteTokens < corpus.summary.bestCaseReadTokens,
  })),
};
result.breakEven = {
  greppedRead: {
    defaultEmitted: breakEven(result.curve, "defaultWins"),
    tier1Lean: breakEven(result.curve, "tier1Wins"),
    profileRoute: breakEven(result.curve, "routeWins"),
  },
  bestCaseRead: {
    defaultEmitted: breakEven(result.curve, "defaultWinsBestCase"),
    tier1Lean: breakEven(result.curve, "tier1WinsBestCase"),
    profileRoute: breakEven(result.curve, "routeWinsBestCase"),
  },
};

fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2) + "\n");
fs.writeFileSync(path.join(outDir, "summary.md"), markdown(result));
process.stdout.write(markdown(result));

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

function measureCorpus(corpus) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `nodenet-breakeven-${corpus.id}-`));
  try {
    populate(corpus, temp);
    const build = spawnSync(process.execPath, [cli, "build", "--json"], { cwd: temp, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (build.status !== 0) return { ...corpus, skipped: `build failed: ${(build.stderr || build.stdout).slice(0, 300)}` };
    const graph = JSON.parse(fs.readFileSync(path.join(temp, ".nodenet", "graph.json"), "utf8"));
    const authored = authoredCorpus(temp);
    const targets = selectTargets(graph);
    if (targets.length === 0) return { ...corpus, graph: { nodes: graph.nodes.length, edges: graph.edges.length }, skipped: "no code symbols eligible as targets" };
    const measurements = targets.map((target) => measureTarget(temp, target, authored)).filter(Boolean);
    if (measurements.length === 0) return { ...corpus, graph: { nodes: graph.nodes.length, edges: graph.edges.length }, skipped: "no target resolved to a context bundle" };
    return {
      ...corpus,
      graph: { nodes: graph.nodes.length, edges: graph.edges.length },
      authored: { files: authored.length, tokens: Math.ceil(authored.reduce((sum, file) => sum + file.bytes, 0) / 4) },
      targets: measurements,
      summary: {
        cases: measurements.length,
        greppedReadTokens: median(measurements.map((item) => item.baseline.greppedReadTokens)),
        bestCaseReadTokens: median(measurements.map((item) => item.baseline.bestCaseReadTokens)),
        defaultEmittedTokens: median(measurements.map((item) => item.tokens.defaultEmitted)),
        tier1LeanTokens: median(measurements.map((item) => item.tokens.tier1Lean)),
        profileRouteTokens: median(measurements.map((item) => item.tokens.profileRoute)),
      },
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function populate(corpus, temp) {
  if (!corpus.subset) {
    fs.cpSync(corpus.source, temp, { recursive: true, filter: (entry) => !excluded(corpus.source, entry) });
    return;
  }
  for (const relative of [...corpus.subset, ...SUBSET_ROOT_FILES]) {
    const from = path.join(corpus.source, relative);
    if (!fs.existsSync(from)) continue;
    const to = path.join(temp, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, filter: (entry) => !excluded(corpus.source, entry) });
  }
}

function measureTarget(cwd, target, authored) {
  const outcome = spawnSync(process.execPath, [cli, "context", target.name, "--detail", "evidence", "--no-cache", "--json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (outcome.status !== 0 || !outcome.stdout.trim()) return null;
  const bundle = JSON.parse(outcome.stdout);
  const matches = authored.filter((file) => file.text.includes(target.name));
  const definition = authored.find((file) => file.relative === target.path);
  return {
    target: target.name,
    resolvedTarget: bundle.target,
    evidenceItems: bundle.codeEvidence.length,
    baseline: {
      grepMatchedFiles: matches.length,
      greppedReadTokens: Math.ceil(matches.reduce((sum, file) => sum + file.bytes, 0) / 4),
      bestCaseReadTokens: definition ? Math.ceil(definition.bytes / 4) : 0,
    },
    tokens: {
      reportedEstimate: bundle.metrics.estimatedTokens,
      defaultEmitted: Math.ceil(Buffer.byteLength(outcome.stdout) / 4),
      tier1Lean: Math.ceil(Buffer.byteLength(JSON.stringify(tier1(bundle))) / 4),
      profileRoute: Math.ceil(Buffer.byteLength(JSON.stringify(route(bundle))) / 4),
    },
  };
}

function selectTargets(graph) {
  const degree = new Map();
  for (const edge of graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  return graph.nodes
    .filter((node) => CODE_KINDS.has(node.kind) && typeof node.name === "string" && node.name.length > 3 && typeof node.path === "string")
    .map((node) => ({ name: node.name, path: node.path, degree: degree.get(node.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name))
    .filter((node, index, list) => list.findIndex((item) => item.name === node.name) === index)
    .slice(0, TARGETS_PER_CORPUS);
}

function tier1(bundle) {
  const { codeContext: _codeContext, ...rest } = bundle;
  return { ...rest, codeEvidence: bundle.codeEvidence.map(({ selectionReason: _reason, ...item }) => item) };
}

function route(bundle) {
  const fields = ["target", "recommendedFiles", "livingContext", "ownership", "authority", "changeBoundaries", "aiGuidance", "secretFlagged"];
  const out = {};
  for (const field of fields) if (bundle[field] !== undefined) out[field] = bundle[field];
  return out;
}

function authoredCorpus(directory) {
  const files = [];
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!AUTHORED.test(entry.name)) continue;
      const bytes = fs.statSync(absolute).size;
      if (bytes > 2 * 1024 * 1024) continue;
      files.push({ relative: path.relative(directory, absolute), bytes, text: fs.readFileSync(absolute, "utf8") });
    }
  }
  return files;
}

function excluded(source, entry) {
  return path
    .relative(source, entry)
    .split(path.sep)
    .some((part) => EXCLUDED.has(part));
}

function breakEven(curve, field) {
  const winner = curve.find((point) => point[field]);
  const lastLoser = [...curve].reverse().find((point) => !point[field]);
  if (!winner) return { wins: false, detail: "does not win at any measured corpus size" };
  return {
    wins: true,
    firstWinningNodes: winner.nodes,
    firstWinningCorpus: winner.id,
    lastLosingNodes: lastLoser ? lastLoser.nodes : null,
    detail: lastLoser ? `between ${lastLoser.nodes} and ${winner.nodes} graph nodes` : `at or below ${winner.nodes} graph nodes`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function markdown(result) {
  const rows = result.curve
    .map(
      (point) =>
        `| ${point.label} | ${point.nodes} | ${point.authoredFiles} | ${point.greppedReadTokens} | ${point.bestCaseReadTokens} | ${point.defaultEmittedTokens} ${flag(point.defaultWins, point.defaultWinsBestCase)} | ${point.tier1LeanTokens} ${flag(point.tier1Wins, point.tier1WinsBestCase)} | ${point.profileRouteTokens} ${flag(point.routeWins, point.routeWinsBestCase)} |`,
    )
    .join("\n");
  const skipped = result.corpora
    .filter((corpus) => corpus.skipped)
    .map((corpus) => `- ${corpus.id}: ${corpus.skipped}`)
    .join("\n");
  return `# NodeNet token break-even curve

Generated: ${result.generatedAt}
Estimator: ${result.estimator}
Targets per corpus: ${TARGETS_PER_CORPUS} highest-degree code symbols (deterministic selection). All figures are medians.

## Curve

| Corpus | Graph nodes | Authored files | Grepped read | Best-case read | NodeNet default (emitted) | Tier 1 lean | Profile route |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}

\`WIN\` marks a variant costing fewer tokens than the grepped-read baseline for the same target.
\`WIN+\` marks a variant that also beats the strict best-case baseline (a perfect-luck agent that opens only the defining file).

- Baseline \`grepped read\` = ${result.baselines.greppedRead}.
- Baseline \`best-case read\` = ${result.baselines.bestCaseRead}.

## Break-even

Against the grepped-read baseline (an agent that opens every grep candidate):

| Variant | Wins from | Detail |
| --- | --- | --- |
| Default (emitted) | ${describe(result.breakEven.greppedRead.defaultEmitted)} | ${result.breakEven.greppedRead.defaultEmitted.detail} |
| Tier 1 lean | ${describe(result.breakEven.greppedRead.tier1Lean)} | ${result.breakEven.greppedRead.tier1Lean.detail} |
| Profile route | ${describe(result.breakEven.greppedRead.profileRoute)} | ${result.breakEven.greppedRead.profileRoute.detail} |

Against the strict best-case baseline (an agent that somehow opens only the defining file):

| Variant | Wins from | Detail |
| --- | --- | --- |
| Default (emitted) | ${describe(result.breakEven.bestCaseRead.defaultEmitted)} | ${result.breakEven.bestCaseRead.defaultEmitted.detail} |
| Tier 1 lean | ${describe(result.breakEven.bestCaseRead.tier1Lean)} | ${result.breakEven.bestCaseRead.tier1Lean.detail} |
| Profile route | ${describe(result.breakEven.bestCaseRead.profileRoute)} | ${result.breakEven.bestCaseRead.profileRoute.detail} |
${skipped ? `\n## Skipped corpora\n\n${skipped}\n` : ""}
## Reproduction

\`\`\`bash
npm run build
node scripts/token-breakeven-curve.mjs
\`\`\`

Case-level evidence: \`benchmark-results/token-breakeven/latest/results.json\`.
`;
}

function flag(wins, winsBestCase) {
  if (winsBestCase) return "**WIN+**";
  return wins ? "**WIN**" : "";
}

function describe(entry) {
  return entry.wins ? `${entry.firstWinningNodes} nodes` : "never";
}
