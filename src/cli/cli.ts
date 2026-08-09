#!/usr/bin/env node
/**
 * NodeNet CLI (NodeNet spec §54).
 *
 * Commands: init, build, update, watch, query, related, trace, context,
 * explain, owner, governed-by, impact, reviewers, conflicts, health,
 * report, graph, doctor. Machine-readable output via --json where appropriate.
 */

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import type { LoadedConfig } from "../config/config.js";
import { loadConfig, writeConfigTemplate } from "../config/config.js";
import { buildCodeGraph, type CodeGraphIndex } from "../analyzer/code-graph.js";
import { attachGovernanceLayers } from "../analyzer/governance.js";
import {
  loadGraph,
  saveGraph,
  ensureDotNodenet,
  loadFingerprints,
  saveFingerprints,
  appendAudit,
  saveSymbolCache,
  loadSymbolCache,
  type CachedSymbol,
  verifyAuditChain,
} from "../storage/storage.js";
import type { Graph } from "../graph/graph.js";
import type { GraphNode } from "../graph/nodes.js";
import { nodeLabel } from "../graph/nodes.js";
import { findPath, neighbors } from "../graph/traversal.js";
import { analyzeImpact, type ImpactReport } from "../change/impact.js";
import { resolveReviewers, type ReviewResolution } from "../review/resolver.js";
import { computeHealth, type HealthReport } from "../health/health.js";
import { buildContextBundle, estimateWireTokens, type ContextBundle } from "../ai/context-builder.js";
import { askGraph, affectedByTarget, leanAskResult } from "../ai/retrieval.js";
import { appendRetrievalFeedback, RETRIEVAL_OUTCOMES, type RetrievalOutcome } from "../ai/feedback.js";
import { contextCacheKey, readContextCache, writeContextCache } from "../ai/context-cache.js";
import { renderGraphHtml } from "../visualization/html.js";
import type { GovernanceMapOptions } from "../visualization/governance-map.js";
import { renderGraphSvg } from "../visualization/svg.js";
import { safeRelativePath, type SafeRelativePath } from "../security/filesystem.js";
import { errorMessage } from "../types/result.js";
import { matchGlob } from "../utils/glob.js";
import type { ContextRecord } from "../context/schema.js";
import type { OwnershipIndex } from "../ownership/resolver.js";
import type { ParsedSymbol, ParsedSymbolKind } from "../parser/typescript.js";
import { runPrIntegration } from "../github/github.js";
import { resolveGitHubToken, resolvePullNumber } from "../github/client.js";
import { handleMcpLine, prepareMcpContext, MCP_SCOPES, type McpScope } from "../mcp/server.js";
import { buildReport, renderReportMarkdown } from "../report/report.js";
import type { AnalysisState } from "../types/analysis-state.js";
import { buildGovernanceDecision, isGovernanceMode, type GovernanceMode } from "../governance/decision.js";
import { legacyToLcddContext } from "../context/lcdd.js";
import { FileRegistry, validateContextFull } from "@lcdd/core";
import { AGENT_PLATFORMS, installAgentGuidance, uninstallAgentGuidance, type AgentPlatform } from "../integration/installer.js";
import { startMcpHttpServer } from "../mcp/http.js";
import { analyzeChangeCollisions } from "../change/collisions.js";
import { languageSupportMatrix } from "../parser/registry.js";
import { startGraphDevServer } from "../visualization/dev-server.js";
import { assessReadiness } from "../onboarding/readiness.js";
import { bootstrapRepository } from "../onboarding/bootstrap.js";
import { loadBenchmarkCases, scoreBenchmark } from "../evaluation/benchmark.js";
import { runLanguageBenchmark } from "../evaluation/language-benchmark.js";
import { loadRetrievalBenchmark, runRetrievalBenchmark } from "../evaluation/retrieval-benchmark.js";
import { loadExecutableGovernanceCases, runGovernanceBenchmark } from "../evaluation/governance-benchmark.js";
import type { DecisionOverride } from "../governance/audit.js";
import { resolveGitHubIdentity } from "../identity/identity.js";
import { importGitHubHistory } from "../evaluation/github-import.js";
import { loadDataset, loadEvaluationRun, loadLabels, saveDataset, saveEvaluationRun } from "../evaluation/store.js";
import { replayDataset } from "../evaluation/replay.js";
import { buildEvaluationReport, evaluationGate } from "../evaluation/report.js";
import { startLabelServer } from "../evaluation/label-server.js";
import { NODENET_VERSION } from "../version.js";

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface BuiltState {
  graph: Graph;
  index: CodeGraphIndex;
  contexts: ContextRecord[];
  ownership: OwnershipIndex;
  warnings: string[];
}

function buildState(root: string, config: LoadedConfig): BuiltState {
  const build = buildCodeGraph(root, config, { incrementalCache: true });
  if (!build.ok) {
    throw new Error(`Graph build failed: ${build.error.message}`);
  }
  const governance = attachGovernanceLayers(build.value.graph, root, config);
  if (!governance.ok) {
    throw new Error(`Governance layers failed: ${governance.error.message}`);
  }
  const saved = saveGraph(root, build.value.graph);
  if (!saved.ok) {
    throw new Error(`Cannot persist graph: ${saved.error.message}`);
  }
  saveFingerprints(root, computeFingerprints(build.value.index, root));
  saveSymbolCache(root, symbolCacheFromIndex(build.value.index));
  return {
    graph: build.value.graph,
    index: build.value.index,
    contexts: governance.value.contexts,
    ownership: governance.value.ownership,
    warnings: [...build.value.warnings, ...governance.value.warnings],
  };
}

function symbolCacheFromIndex(index: CodeGraphIndex): Map<string, CachedSymbol[]> {
  const map = new Map<string, CachedSymbol[]>();
  for (const [p, parsed] of index.parsedFiles) {
    map.set(
      p.toString(),
      parsed.symbols.map((s) => ({
        kind: s.kind,
        name: s.name,
        startLine: s.startLine,
        endLine: s.endLine,
        exported: s.exported,
        isDefault: s.isDefault,
      })),
    );
  }
  return map;
}

function computeFingerprints(index: CodeGraphIndex, root: string): Map<string, { size: number; mtimeMs: number }> {
  const map = new Map<string, { size: number; mtimeMs: number }>();
  for (const p of index.fileNodes.keys()) {
    try {
      const stat = fs.statSync(path.join(root, p.toString()));
      map.set(p.toString(), { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // file may have been deleted mid-scan
    }
  }
  return map;
}

function loadForAnalysis(root: string, config: LoadedConfig): BuiltState {
  const stored = loadGraph(root, { maxNodes: config.limits.maxGraphNodes, maxEdges: config.limits.maxGraphEdges });
  if (stored.ok && stored.value) {
    const index = reconstructIndex(stored.value);
    applySymbolCache(index, loadSymbolCache(root));
    const governance = attachGovernanceLayers(stored.value, root, config);
    if (governance.ok) {
      return {
        graph: stored.value,
        index,
        contexts: governance.value.contexts,
        ownership: governance.value.ownership,
        warnings: governance.value.warnings,
      };
    }
  }
  return buildState(root, config);
}

/** Overlay persisted symbol line ranges onto the reconstructed index. */
function applySymbolCache(index: CodeGraphIndex, cache: Map<string, CachedSymbol[]>): void {
  for (const [file, cached] of cache) {
    const safe = safeRelativePath(file);
    if (!safe.ok) continue;
    const existing = index.parsedFiles.get(safe.value);
    if (!existing) continue;
    existing.symbols = cached.map((s) => ({
      kind: (s.kind as ParsedSymbolKind) ?? "function",
      name: s.name,
      startLine: s.startLine,
      endLine: s.endLine,
      exported: s.exported,
      isDefault: s.isDefault,
      references: [],
      jsxRefs: [],
      heritage: [],
    }));
  }
}

/** Rebuild the code-graph index from a stored graph (no re-parse needed). */
function reconstructIndex(graph: Graph): CodeGraphIndex {
  const index: CodeGraphIndex = {
    fileNodes: new Map(),
    parsedFiles: new Map(),
    symbolsByFile: new Map(),
    exportedByFile: new Map(),
    packageDirByName: new Map(),
    packageNodeByDir: new Map(),
  };
  for (const node of graph.nodes()) {
    if (node.kind === "file") {
      const p = (node as { path: SafeRelativePath }).path;
      index.fileNodes.set(p, node.id);
    }
  }
  for (const node of graph.nodes()) {
    switch (node.kind) {
      case "function":
      case "method":
      case "class":
      case "interface":
      case "typeAlias":
      case "enum":
      case "variable":
      case "reactComponent":
      case "reactHook": {
        const p = (node as { path: SafeRelativePath }).path;
        const map = index.symbolsByFile.get(p) ?? new Map<string, import("../types/brand.js").NodeId[]>();
        const list = map.get(node.name) ?? [];
        list.push(node.id);
        map.set(node.name, list);
        index.symbolsByFile.set(p, map);
        break;
      }
      case "package": {
        const pkg = node as { name: string; external: boolean; path?: SafeRelativePath };
        if (pkg.external) break;
        const dir = pkg.path ?? ("" as SafeRelativePath);
        index.packageNodeByDir.set(dir, node.id);
        index.packageDirByName.set(pkg.name, dir);
        break;
      }
      default:
        break;
    }
  }
  // exported symbols via exports edges
  for (const edge of graph.edges()) {
    if (edge.relation !== "exports") continue;
    const from = graph.getNode(edge.from);
    const to = graph.getNode(edge.to);
    if (from?.kind !== "file" || !to) continue;
    const p = (from as { path: SafeRelativePath }).path;
    const map = index.exportedByFile.get(p) ?? new Map<string, import("../types/brand.js").NodeId[]>();
    const list = map.get(to.name) ?? [];
    list.push(to.id);
    map.set(to.name, list);
    index.exportedByFile.set(p, map);
  }
  // minimal parsed-file records (line info for symbol-level diff)
  for (const [p, ids] of index.symbolsByFile) {
    const symbols: ParsedSymbol[] = [];
    for (const idList of ids.values()) {
      for (const id of idList) {
      const node = graph.getNode(id);
      if (!node) continue;
      const parsedKind: ParsedSymbolKind =
        node.kind === "reactComponent" ? "reactComponent" :
        node.kind === "reactHook" ? "reactHook" :
        node.kind === "method" ? "method" :
        node.kind === "class" ? "class" :
        node.kind === "interface" ? "interface" :
        node.kind === "typeAlias" ? "typeAlias" :
        node.kind === "enum" ? "enum" :
        node.kind === "variable" ? "variable" : "function";
        symbols.push({
          kind: parsedKind,
          name: node.name,
          startLine: (node as { line: number }).line,
          endLine: (node as { line: number }).line,
          exported: (node as { exported: boolean }).exported,
          isDefault: false,
          references: [],
          jsxRefs: [],
          heritage: [],
        });
      }
    }
    index.parsedFiles.set(p, {
      path: p,
      language: "typescript",
      symbols,
      imports: [],
      reexports: [],
      exportedLocalNames: [],
      hasSyntaxErrors: false,
    });
  }
  return index;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

let prettyJsonOutput = false;

function printJson(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(value, null, prettyJsonOutput ? 2 : undefined) + "\n");
  }
}

function appendTokenLog(root: string, command: string, payload: unknown): void {
  const directory = path.join(root, ".nodenet");
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(path.join(directory, "token-log.jsonl"), JSON.stringify({
    at: new Date().toISOString(), command, emittedTokens: estimateWireTokens(payload, prettyJsonOutput), pretty: prettyJsonOutput,
  }) + "\n", { encoding: "utf8", mode: 0o600 });
}

function legacyContextPayload(bundle: ContextBundle): Record<string, unknown> {
  return {
    ...bundle,
    codeContext: bundle.codeEvidence.map((entry) => entry.label),
    codeEvidence: bundle.codeEvidence.map((entry) => ({
      ...entry,
      selectionReason: `${entry.direction} ${entry.relation} relation at depth ${entry.depth ?? "unknown"}; provenance=${entry.provenance ?? "unknown"}; deterministic score=${entry.score ?? "unknown"}`,
    })),
  };
}

function humanNode(node: GraphNode): string {
  return nodeLabel(node);
}

function findNodeByName(graph: Graph, name: string): GraphNode | undefined {
  const exact = graph.queryByName(name);
  if (exact.length === 0) return undefined;
  return exact[0];
}

function nodeToRecord(node: GraphNode): Record<string, unknown> {
  const record: Record<string, unknown> = { kind: node.kind, name: node.name, id: node.id };
  const p = (node as { path?: string }).path;
  if (typeof p === "string") record["path"] = p;
  if ("line" in node) record["line"] = (node as { line: number }).line;
  return record;
}

/** Rank exact symbols above fuzzy symbols and filename-only matches, then
 * expand an exact class hit with methods declared in the same source file.
 * Pattern adapters do not always retain class scope, so file locality is the
 * most reliable cross-language fallback. */
function queryMatches(graph: Graph, name: string): GraphNode[] {
  const initial = graph.queryByName(name);
  const exactClass = initial.find((node) => node.kind === "class" && node.name.toLowerCase() === name.toLowerCase());
  if (!exactClass || !("path" in exactClass)) return initial;
  const path = exactClass.path;
  const expanded = graph.findNodes((node) => node.kind === "method" && "path" in node && node.path === path);
  const seen = new Set(initial.map((node) => node.id));
  return [...initial, ...expanded.filter((node) => !seen.has(node.id))];
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function runCli(argv: string[], opts: { cwd?: string } = {}): Promise<number> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  let commandExitCode = 0;
  const program = new Command();
  program
    .name("nodenet")
    .description("NodeNet maps code, context, ownership, and authority into an explainable graph.")
    .version(NODENET_VERSION);

  const withJson = (cmd: Command): Command => cmd
    .option("--json", "machine-readable JSON output")
    .option("--pretty", "pretty-print JSON (compact is the default)")
    .hook("preAction", (_thisCommand, actionCommand) => { prettyJsonOutput = Boolean(actionCommand.opts()["pretty"]); });

  // -- init -------------------------------------------------------------------
  program
    .command("init")
    .description("Create nodenet.config.json and the .nodenet directory")
    .action(() => {
      writeConfigTemplate(cwd);
      ensureDotNodenet(cwd);
      appendAudit(cwd, { type: "cli.init", at: new Date().toISOString() });
      process.stdout.write("Initialized NodeNet. Edit nodenet.config.json, then run `nodenet build`.\n");
    });

  // -- build ------------------------------------------------------------------
  withJson(
    program
      .command("build")
      .description("Scan the repository, parse code, and persist the unified graph")
      .action(async (cmdOptions: { json?: boolean }) => {
        const config = loadConfigChecked(cwd);
        const state = buildState(cwd, config);
        printJson(
          {
            ok: true,
            nodes: state.graph.size,
            edges: state.graph.edgeCount,
            contexts: state.contexts.length,
            warnings: state.warnings,
          },
          cmdOptions.json ?? false,
        );
        if (!(cmdOptions.json ?? false)) {
          process.stdout.write(
            `Graph built: ${state.graph.size} nodes, ${state.graph.edgeCount} edges, ${state.contexts.length} contexts.\n`,
          );
          for (const w of state.warnings) process.stdout.write(`warning: ${w}\n`);
        }
      }),
  );

  // -- update -----------------------------------------------------------------
  program
    .command("update")
    .description("Incremental update — only re-analyzes files whose fingerprints changed")
    .action(() => {
      const config = loadConfigChecked(cwd);
      const before = loadFingerprints(cwd);
      const state = buildState(cwd, config);
      const after = computeFingerprints(state.index, cwd);
      const changed: string[] = [];
      const added: string[] = [];
      const removed: string[] = [];
      for (const [p, fp] of after) {
        const prev = before.get(p);
        if (!prev) added.push(p);
        else if (prev.size !== fp.size || prev.mtimeMs !== fp.mtimeMs) changed.push(p);
      }
      for (const p of before.keys()) {
        if (!after.has(p)) removed.push(p);
      }
      if (added.length + changed.length + removed.length === 0) {
        process.stdout.write("Graph is up to date.\n");
        return;
      }
      process.stdout.write(
        `Updated: ${changed.length} modified, ${added.length} added, ${removed.length} removed; unchanged parse results reused from local cache.\n`,
      );
      for (const p of changed) process.stdout.write(`  ~ ${p}\n`);
      for (const p of added) process.stdout.write(`  + ${p}\n`);
      for (const p of removed) process.stdout.write(`  - ${p}\n`);
    });

  // -- watch ------------------------------------------------------------------
  program
    .command("watch")
    .description("Rebuild the graph whenever the repository changes (polling)")
    .option("-i, --interval <seconds>", "poll interval in seconds", "5")
    .action((cmdOptions: { interval: string }) => {
      const intervalMs = Math.max(1, Number(cmdOptions.interval) || 5) * 1000;
      const config = loadConfigChecked(cwd);
      process.stdout.write(`Watching ${cwd} every ${intervalMs / 1000}s. Ctrl-C to stop.\n`);
      let last = new Map<string, { size: number; mtimeMs: number }>();
      const tick = (): void => {
        try {
          const build = buildCodeGraph(cwd, config);
          if (build.ok) {
            const current = computeFingerprints(build.value.index, cwd);
            let dirty = current.size !== last.size;
            if (!dirty) {
              for (const [p, fp] of current) {
                const prev = last.get(p);
                if (!prev || prev.size !== fp.size || prev.mtimeMs !== fp.mtimeMs) {
                  dirty = true;
                  break;
                }
              }
            }
            if (dirty) {
              buildState(cwd, config);
              process.stdout.write(`[${new Date().toISOString()}] graph rebuilt\n`);
              last = current;
            }
          }
        } catch (e) {
          process.stdout.write(`[${new Date().toISOString()}] rebuild failed: ${errorMessage(e)}\n`);
        }
      };
      tick();
      const timer = setInterval(tick, intervalMs);
      const stop = (): void => {
        clearInterval(timer);
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });

  // -- query ------------------------------------------------------------------
  withJson(
    program
      .command("query <name>")
      .description("Search the graph for nodes by name")
      .action((name: string, cmdOptions: { json?: boolean }) => {
        const { graph } = loadForAnalysis(cwd, loadConfigChecked(cwd));
        const matches = queryMatches(graph, name).slice(0, 200);
        if (cmdOptions.json) {
          printJson(matches.map(nodeToRecord), true);
          return;
        }
        for (const node of matches) process.stdout.write(`${humanNode(node)}\n`);
        if (matches.length === 0) process.stdout.write("No matches.\n");
      }),
  );

  // -- ask --------------------------------------------------------------------
  withJson(
    program
      .command("ask <question>")
      .description("Retrieve an intent-aware, token-efficient subgraph for a natural-language question")
      .option("--limit <number>", "maximum ranked matches", "30")
      .option("--full", "include verbose matches, connections, and ranking explanations")
      .action((question: string, cmdOptions: { json?: boolean; limit?: string; full?: boolean }) => {
        const { graph } = loadForAnalysis(cwd, loadConfigChecked(cwd));
        const limit = Number(cmdOptions.limit ?? "30");
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be an integer from 1 to 100.");
        const result = askGraph(graph, question, limit);
        if (cmdOptions.json) {
          const payload = cmdOptions.full ? result : leanAskResult(result);
          appendTokenLog(cwd, "ask", payload);
          return printJson(payload, true);
        }
        process.stdout.write(`query id: ${result.queryId}\nintent: ${result.intent}\n`);
        for (const match of result.matches) process.stdout.write(`${match.score.toString().padStart(3)} ${match.name}${match.path ? ` @ ${match.path}` : ""}\n`);
        if (!result.matches.length) process.stdout.write("No matches. Refine the question with a symbol or file name.\n");
        if (result.suggestedNext.length) process.stdout.write(`next:\n${result.suggestedNext.map((item) => `  ${item}`).join("\n")}\n`);
      }),
  );

  // -- affected ---------------------------------------------------------------
  withJson(
    program
      .command("affected <target>")
      .description("Explore the hypothetical graph blast radius of a symbol or file")
      .option("--depth <number>", "maximum graph depth", "2")
      .action((target: string, cmdOptions: { json?: boolean; depth?: string }) => {
        const config = loadConfigChecked(cwd);
        const { graph } = loadForAnalysis(cwd, config);
        const depth = Number(cmdOptions.depth ?? "2");
        if (!Number.isInteger(depth) || depth < 1 || depth > config.limits.maxTraversalDepth) throw new Error(`--depth must be an integer from 1 to ${config.limits.maxTraversalDepth}.`);
        const result = affectedByTarget(graph, config, target, depth);
        if (!result) { process.stdout.write(`No target matched "${target}".\n`); return; }
        if (cmdOptions.json) return printJson(result, true);
        process.stdout.write(`${result.target.name}\n`);
        for (const item of result.affected) process.stdout.write(`  -> ${item.name}${item.path ? ` @ ${item.path}` : ""}\n`);
        if (result.truncated) process.stdout.write("Result truncated by traversal limits.\n");
      }),
  );

  // -- related ----------------------------------------------------------------
  withJson(
    program
      .command("related <name>")
      .description("Show nodes directly connected to a node")
      .action((name: string, cmdOptions: { json?: boolean }) => {
        const { graph } = loadForAnalysis(cwd, loadConfigChecked(cwd));
        const node = findNodeByName(graph, name);
        if (!node) {
          process.stdout.write(`No node matching "${name}".\n`);
          return;
        }
        const related = neighbors(graph, node.id);
        if (cmdOptions.json) {
          printJson(
            related.map((r) => ({
              node: nodeToRecord(r.node),
              edges: r.edges.map((e) => ({ relation: e.relation, id: e.id })),
            })),
            true,
          );
          return;
        }
        process.stdout.write(`${humanNode(node)}\n`);
        for (const { node: other, edges } of related) {
          const rels = edges.map((e) => e.relation).join(", ");
          process.stdout.write(`  --${rels}--> ${humanNode(other)}\n`);
        }
      }),
  );

  // -- trace ------------------------------------------------------------------
  withJson(
    program
      .command("trace <from> <to>")
      .description("Find a path between two nodes")
      .action((fromName: string, toName: string, cmdOptions: { json?: boolean }) => {
        const config = loadConfigChecked(cwd);
        const { graph } = loadForAnalysis(cwd, config);
        const from = findNodeByName(graph, fromName);
        const to = findNodeByName(graph, toName);
        if (!from || !to) {
          process.stdout.write(`No path: could not resolve "${!from ? fromName : toName}".\n`);
          return;
        }
        const chain = findPath(
          graph,
          from.id,
          to.id,
          { maxDepth: config.limits.maxTraversalDepth, maxNodes: config.limits.maxTraversalNodes },
          (edge) => edge.relation !== "contains",
        );
        if (!chain) {
          process.stdout.write(`No path found between ${fromName} and ${toName}.\n`);
          return;
        }
        if (cmdOptions.json) {
          printJson(chain.map((e) => ({ from: e.from, relation: e.relation, to: e.to })), true);
          return;
        }
        process.stdout.write(humanNode(from) + "\n");
        let current = from.id;
        for (const edge of chain) {
          const next = edge.from === current ? edge.to : edge.from;
          const nextNode = graph.getNode(next);
          process.stdout.write(`  --${edge.relation}--> ${nextNode ? humanNode(nextNode) : next}\n`);
          current = next;
        }
      }),
  );

  // -- context ----------------------------------------------------------------
  withJson(
    program
      .command("context [target]")
      .description("List living contexts, or build an AI context bundle for a target")
      .option("--propose <id>", "record a Context Change Proposal (does NOT modify active context)")
      .option("--migrate", "preview migration of legacy contexts to the LCDD 0.6 Registry")
      .option("--write", "write migration output (requires --migrate)")
      .option("--max-tokens <number>", "advanced: override the automatic AI context budget")
      .option("--detail <level>", "progressive detail: route, map, evidence, or source", "evidence")
      .option("--compat <version>", "legacy wire compatibility (v1)")
      .option("--no-cache", "do not read or write the local context cache")
      .action((target: string | undefined, cmdOptions: { json?: boolean; propose?: string; migrate?: boolean; write?: boolean; maxTokens?: string; detail?: string; cache?: boolean; compat?: string }) => {
        const config = loadConfigChecked(cwd);
        const state = loadForAnalysis(cwd, config);
        if (cmdOptions.write && !cmdOptions.migrate) {
          throw new Error("--write requires --migrate.");
        }
        if (cmdOptions.migrate) {
          const legacy = state.contexts.filter((context) => context.sourceFormat !== "lcdd-0.6");
          const canonical = legacy.map(legacyToLcddContext);
          const invalid = canonical.flatMap((context) => {
            const validation = validateContextFull(context);
            return validation.valid ? [] : [{ id: context.id, errors: validation.errors }];
          });
          if (invalid.length > 0) {
            throw new Error(`Cannot migrate invalid Contexts: ${invalid.map((item) => `${item.id}: ${item.errors.join("; ")}`).join(" | ")}`);
          }
          if (cmdOptions.write) {
            const registry = new FileRegistry(cwd);
            for (const context of canonical) registry.save(context);
          }
          const migration = {
            version: "LCDD 0.6.0",
            mode: cmdOptions.write ? "write" : "preview",
            contexts: canonical.map((context) => ({ id: context.id, version: context.version, lifecycle: context.lifecycle })),
          };
          if (cmdOptions.json) printJson(migration, true);
          else {
            process.stdout.write(`${cmdOptions.write ? "Migrated" : "Would migrate"} ${canonical.length} Context(s) to .lcdd/contexts/.\n`);
            if (!cmdOptions.write) process.stdout.write("Run with --migrate --write to persist the LCDD 0.6 artifacts.\n");
          }
          return;
        }
        if (cmdOptions.propose) {
          const ctx = state.contexts.find((c) => c.id === cmdOptions.propose);
          if (!ctx) {
            process.stdout.write(`Unknown context id: ${cmdOptions.propose}\n`);
            return;
          }
          appendAudit(cwd, {
            type: "context.proposed",
            contextId: ctx.id,
            fromStatus: ctx.status,
            by: config.developer.handle ?? "unknown",
            at: new Date().toISOString(),
          });
          process.stdout.write(
            `Context Change Proposal recorded for ${ctx.id} (${ctx.status}). ` +
              `The ACTIVE context was NOT modified. It must be reviewed and approved before any change.\n`,
          );
          return;
        }
        if (!target) {
          if (cmdOptions.json) {
            printJson(state.contexts, true);
            return;
          }
          for (const ctx of state.contexts) {
            process.stdout.write(
              `${ctx.id} [${ctx.status}] ${ctx.authority} — ${ctx.title} (approvers: ${ctx.approvedBy.join(", ") || "none"})\n`,
            );
          }
          if (state.contexts.length === 0) process.stdout.write("No living contexts declared.\n");
          return;
        }
        const requestedBudget = cmdOptions.maxTokens === undefined ? undefined : Number(cmdOptions.maxTokens);
        if (requestedBudget !== undefined && (!Number.isFinite(requestedBudget) || requestedBudget <= 0)) {
          throw new Error("--max-tokens must be a positive number.");
        }
        const detail = cmdOptions.detail ?? "evidence";
        if (!["route", "map", "evidence", "source"].includes(detail)) throw new Error("--detail must be route, map, evidence, or source.");
        if (cmdOptions.compat !== undefined && cmdOptions.compat !== "v1") throw new Error("--compat currently supports only v1.");
        const bundleOptions = {
          ...(requestedBudget !== undefined ? { maxTokens: requestedBudget } : {}),
          detail: detail as "route" | "map" | "evidence" | "source",
          ...(detail === "source" ? { root: cwd } : {}),
        };
        const key = contextCacheKey({ graphBuiltAt: state.graph.metadata.builtAt, target, options: bundleOptions, contextFingerprint: JSON.stringify(state.contexts) });
        const bundle = cmdOptions.cache !== false ? readContextCache(cwd, key) ?? buildContextBundle(state.graph, state.index, state.ownership, state.contexts, target, bundleOptions) : buildContextBundle(state.graph, state.index, state.ownership, state.contexts, target, bundleOptions);
        if (!bundle) {
          process.stdout.write(`No target matched "${target}". Try a symbol or file name.\n`);
          return;
        }
        if (cmdOptions.cache !== false) writeContextCache(cwd, key, bundle);
        if (cmdOptions.json) {
          const payload = cmdOptions.compat === "v1" ? legacyContextPayload(bundle) : bundle;
          appendTokenLog(cwd, `context:${detail}`, payload);
          printJson(payload, true);
          return;
        }
        printBundle(bundle);
      }),
  );

  program
    .command("feedback")
    .description("Record local opt-in retrieval feedback without changing graph authority")
    .requiredOption("--query-id <id>", "query id emitted by nodenet ask")
    .requiredOption("--outcome <outcome>", `outcome: ${RETRIEVAL_OUTCOMES.join(", ")}`)
    .option("--note <text>", "optional short note")
    .action((cmdOptions: { queryId: string; outcome: string; note?: string }) => {
      if (!RETRIEVAL_OUTCOMES.includes(cmdOptions.outcome as RetrievalOutcome)) throw new Error(`--outcome must be ${RETRIEVAL_OUTCOMES.join(", ")}.`);
      const record = appendRetrievalFeedback(cwd, { queryId: cmdOptions.queryId, outcome: cmdOptions.outcome as RetrievalOutcome, ...(cmdOptions.note ? { note: cmdOptions.note.slice(0, 500) } : {}) });
      process.stdout.write(`Feedback recorded for ${record.queryId}: ${record.outcome}\n`);
    });

  // -- explain ----------------------------------------------------------------
  withJson(
    program
      .command("explain <name>")
      .description("Explain a node: what it is, what connects it, and why")
      .action((name: string, cmdOptions: { json?: boolean }) => {
        const { graph } = loadForAnalysis(cwd, loadConfigChecked(cwd));
        const node = findNodeByName(graph, name);
        if (!node) {
          process.stdout.write(`No node matching "${name}".\n`);
          return;
        }
        const edges = graph.incident(node.id);
        const record = {
          node: nodeToRecord(node),
          relationships: edges.map((e) => ({
            relation: e.relation,
            from: e.from === node.id ? "this" : graph.getNode(e.from)?.name ?? e.from,
            to: e.to === node.id ? "this" : graph.getNode(e.to)?.name ?? e.to,
            provenance: e.provenance,
          })),
        };
        if (cmdOptions.json) {
          printJson(record, true);
          return;
        }
        process.stdout.write(`${humanNode(node)}\n`);
        for (const rel of record.relationships) {
          process.stdout.write(
            `  ${rel.from} --${rel.relation}--> ${rel.to}  (${rel.provenance.source}${rel.provenance.location ? " @ " + rel.provenance.location : ""})\n`,
          );
        }
        if (record.relationships.length === 0) process.stdout.write("  No relationships.\n");
      }),
  );

  // -- owner ------------------------------------------------------------------
  withJson(
    program
      .command("owner <path-or-symbol>")
      .description("Show who owns a file or symbol")
      .option("--explain", "show every matching ownership rule and the selected rule")
      .action((target: string, cmdOptions: { json?: boolean; explain?: boolean }) => {
        const config = loadConfigChecked(cwd);
        const state = loadForAnalysis(cwd, config);
        const filePath = resolveTargetPath(state.graph, state.index, target);
        if (!filePath) {
          process.stdout.write(`Could not resolve "${target}" to a file.\n`);
          return;
        }
        const resolution = state.ownership.resolveOwner(filePath);
        if (!resolution) {
          process.stdout.write(`No declared owner for ${filePath.toString()}.\n`);
          return;
        }
        const matching = state.ownership.matching(filePath).map((record) => ({
          ...record,
          selected: record.owner === resolution.owner && record.source === resolution.source && record.confidence === resolution.confidence,
        }));
        if (cmdOptions.json) {
          printJson({ file: filePath.toString(), ...resolution, ...(cmdOptions.explain ? { matching } : {}) }, true);
          return;
        }
        process.stdout.write(
          `${filePath.toString()} → ${resolution.owner} (source: ${resolution.source}, confidence: ${resolution.confidence})\n`,
        );
        if (cmdOptions.explain) {
          process.stdout.write("Resolution chain (source priority, then confidence):\n");
          for (const record of matching) {
            process.stdout.write(`  ${record.selected ? "SELECTED" : "matched "} ${record.pattern} → ${record.owner} (${record.source}, ${record.confidence})\n`);
          }
        }
      }),
  );

  // -- governed-by -------------------------------------------------------------
  withJson(
    program
      .command("governed-by <name>")
      .description("Show living contexts governing a node")
      .action((name: string, cmdOptions: { json?: boolean }) => {
        const config = loadConfigChecked(cwd);
        const state = loadForAnalysis(cwd, config);
        const filePath = resolveTargetPath(state.graph, state.index, name);
        if (!filePath) {
          process.stdout.write(`Could not resolve "${name}" to a file.\n`);
          return;
        }
        const governing = state.contexts.filter((ctx) =>
          ctx.appliesTo.some((pattern) => matchGlob(pattern, filePath.toString())),
        );
        if (cmdOptions.json) {
          printJson({ target: filePath.toString(), contexts: governing }, true);
          return;
        }
        if (governing.length === 0) {
          process.stdout.write(`No governing context for ${filePath.toString()}.\n`);
          return;
        }
        process.stdout.write(`Contexts governing ${filePath.toString()}:\n`);
        for (const ctx of governing) {
          process.stdout.write(
            `  ${ctx.id} [${ctx.status}] ${ctx.authority} — ${ctx.title} (approvers: ${ctx.approvedBy.join(", ") || "none"})\n`,
          );
        }
      }),
  );

  // -- impact -----------------------------------------------------------------
  withJson(
    program
      .command("impact")
      .description("Analyze the current change (git diff) for impact")
      .option("-b, --base <ref>", "compare against a git ref (e.g. main)")
      .option("--developer-team <team>", "team of the change author (defaults to config)")
      .action((cmdOptions: { json?: boolean; base?: string; developerTeam?: string }) => {
        const config = loadConfigChecked(cwd);
        const state = loadForAnalysis(cwd, config);
        const impact = analyzeImpact(cwd, config, state.graph, state.index, state.ownership, state.contexts, {
          ...(cmdOptions.base !== undefined ? { base: cmdOptions.base } : {}),
          ...(cmdOptions.developerTeam !== undefined ? { developerTeam: cmdOptions.developerTeam } : {}),
        });
        if (!impact.ok) {
          process.stdout.write(`Impact analysis failed: ${impact.error.message}\n`);
          return;
        }
        printImpact(impact.value, cmdOptions.json ?? false);
      }),
  );

  // -- reviewers ---------------------------------------------------------------
  withJson(
    program
      .command("reviewers")
      .description("Resolve reviewers for the current change")
      .option("-b, --base <ref>", "compare against a git ref (e.g. main)")
      .action((cmdOptions: { json?: boolean; base?: string }) => {
        const config = loadConfigChecked(cwd);
        const state = loadForAnalysis(cwd, config);
        const impact = analyzeImpact(cwd, config, state.graph, state.index, state.ownership, state.contexts, {
          ...(cmdOptions.base !== undefined ? { base: cmdOptions.base } : {}),
        });
        if (!impact.ok) {
          process.stdout.write(`Impact analysis failed: ${impact.error.message}\n`);
          return;
        }
        const review = resolveReviewers(cwd, config, impact.value);
        if (cmdOptions.json) {
          printJson(review, true);
          return;
        }
        printReview(review, impact.value);
      }),
  );

  // -- conflicts ---------------------------------------------------------------
  withJson(
    program
      .command("conflicts")
      .description("List conflicting living contexts")
      .action((cmdOptions: { json?: boolean }) => {
        const { contexts } = loadForAnalysis(cwd, loadConfigChecked(cwd));
        const pairs: { a: string; b: string }[] = [];
        for (const ctx of contexts) {
          for (const other of ctx.conflictsWith ?? []) {
            pairs.push({ a: ctx.id, b: other });
          }
        }
        if (cmdOptions.json) {
          printJson(pairs, true);
          return;
        }
        if (pairs.length === 0) {
          process.stdout.write("No conflicting contexts.\n");
          return;
        }
        for (const p of pairs) process.stdout.write(`${p.a} CONFLICTS_WITH ${p.b}\n`);
      }),
  );

  // -- health -----------------------------------------------------------------
  withJson(
    program
      .command("health")
      .description("Report living context health (spec §25)")
      .option("--uncovered", "list files without a resolved owner")
      .action((cmdOptions: { json?: boolean; uncovered?: boolean }) => {
        const config = loadConfigChecked(cwd);
        const state = loadForAnalysis(cwd, config);
        const report = computeHealth(state.graph, state.contexts, state.ownership, config);
        if (cmdOptions.json) {
          printJson(report, true);
          return;
        }
        printHealth(report, cmdOptions.uncovered ?? false);
      }),
  );

  // -- snapshot / diff -------------------------------------------------------
  withJson(
    program
      .command("snapshot")
      .description("Write a deterministic graph snapshot for CI drift checks")
      .option("-o, --output <file>", "snapshot path", ".nodenet/snapshot.json")
      .action((cmdOptions: { json?: boolean; output?: string }) => {
        const state = loadForAnalysis(cwd, loadConfigChecked(cwd));
        const output = path.resolve(cwd, cmdOptions.output ?? ".nodenet/snapshot.json");
        fs.mkdirSync(path.dirname(output), { recursive: true });
        const snapshot = state.graph.toSnapshot();
        const stable = {
          schemaVersion: 1,
          nodenetVersion: NODENET_VERSION,
          nodes: [...snapshot.nodes].sort((a, b) => a.id.localeCompare(b.id)),
          edges: [...snapshot.edges].sort((a, b) => a.id.localeCompare(b.id)),
        };
        fs.writeFileSync(output, JSON.stringify(stable, null, 2) + "\n");
        const result = { output, nodes: stable.nodes.length, edges: stable.edges.length };
        if (cmdOptions.json) return printJson(result, true);
        process.stdout.write(`Snapshot written to ${output} (${result.nodes} nodes, ${result.edges} edges)\n`);
      }),
  );

  withJson(
    program
      .command("diff-snapshot <file>")
      .description("Compare the current graph with a saved NodeNet snapshot")
      .action((file: string, cmdOptions: { json?: boolean }) => {
        const state = loadForAnalysis(cwd, loadConfigChecked(cwd));
        const saved = JSON.parse(fs.readFileSync(path.resolve(cwd, file), "utf8")) as { nodes?: Array<{ id: string }>; edges?: Array<{ id: string }> };
        if (!Array.isArray(saved.nodes) || !Array.isArray(saved.edges)) throw new Error("Invalid NodeNet snapshot: nodes[] and edges[] are required.");
        const current = state.graph.toSnapshot();
        const delta = (before: string[], after: string[]) => {
          const beforeSet = new Set(before);
          const afterSet = new Set(after);
          return {
            added: after.filter((id) => !beforeSet.has(id)).sort(),
            removed: before.filter((id) => !afterSet.has(id)).sort(),
          };
        };
        const nodes = delta(saved.nodes.map((node) => node.id), current.nodes.map((node) => node.id));
        const edges = delta(saved.edges.map((edge) => edge.id), current.edges.map((edge) => edge.id));
        const changed = nodes.added.length + nodes.removed.length + edges.added.length + edges.removed.length > 0;
        const result = { changed, nodes, edges };
        if (changed) commandExitCode = 2;
        if (cmdOptions.json) return printJson(result, true);
        process.stdout.write(changed
          ? `Graph drift detected: nodes +${nodes.added.length}/-${nodes.removed.length}, edges +${edges.added.length}/-${edges.removed.length}\n`
          : "No graph drift detected.\n");
      }),
  );

  // -- report -----------------------------------------------------------------
  withJson(
    program
      .command("report")
      .description("Generate a deterministic highlights report: god nodes, surprising connections, communities, governance")
      .option("--god-nodes <n>", "max god nodes to list", "10")
      .option("--connections <n>", "max surprising connections to list", "10")
      .action((cmdOptions: { json?: boolean; godNodes?: string; connections?: string }) => {
        const config = loadConfigChecked(cwd);
        const state = loadForAnalysis(cwd, config);
        const report = buildReport(state.graph, state.contexts, state.ownership, config, new Date(), {
          godNodes: Math.max(1, Number(cmdOptions.godNodes) || 10),
          connections: Math.max(1, Number(cmdOptions.connections) || 10),
        });
        if (cmdOptions.json) {
          printJson(report, true);
          return;
        }
        process.stdout.write(renderReportMarkdown(report) + "\n");
      }),
  );

  // -- graph ------------------------------------------------------------------
  program
    .command("graph")
    .description("Generate an interactive HTML or static SVG visualization")
    .option("-o, --output <file>", "output file (default .nodenet/graph.html)")
    .option("-f, --format <format>", "output format: html (interactive) or svg (static image)", "html")
    .option("--change", "overlay the current git change impact and governance decision")
    .option("-b, --base <ref>", "git base ref used with --change")
    .action((cmdOptions: { output?: string; format?: string; change?: boolean; base?: string }) => {
      const config = loadConfigChecked(cwd);
      const state = loadForAnalysis(cwd, config);
      const format = cmdOptions.format ?? "html";
      if (format !== "html" && format !== "svg") {
        process.stdout.write(`Unknown format "${format}". Use html or svg.\n`);
        return;
      }
      const out = cmdOptions.output ?? path.join(cwd, ".nodenet", format === "svg" ? "graph.svg" : "graph.html");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      let change: GovernanceMapOptions["change"];
      if (cmdOptions.change && format === "html") {
        const impact = analyzeImpact(cwd, config, state.graph, state.index, state.ownership, state.contexts, {
          ...(cmdOptions.base ? { base: cmdOptions.base } : {}),
        });
        if (!impact.ok) throw impact.error;
        const review = resolveReviewers(cwd, config, impact.value);
        change = {
          decision: buildGovernanceDecision(impact.value, review, "warn"),
          changedNodeIds: impact.value.changedSymbols.flatMap((symbol) => symbol.nodeId ? [symbol.nodeId] : []),
          affectedNodeIds: impact.value.affectedNodeIds,
        };
      }
      const content = format === "svg" ? renderGraphSvg(state.graph) : renderGraphHtml(state.graph, { ...(change ? { change } : {}) });
      fs.writeFileSync(out, content);
      process.stdout.write(`Graph written to ${out}\n`);
    });

  // -- open ------------------------------------------------------------------
  program
    .command("open")
    .description("Open the interactive governance graph and hot-reload on repository changes")
    .option("--no-open", "start the live server without opening a browser")
    .option("--port <port>", "loopback port; 0 selects an available port", "0")
    .option("--change", "overlay current change impact and governance decision")
    .option("-b, --base <ref>", "git base ref used with --change")
    .action(async (cmdOptions: { open?: boolean; port?: string; change?: boolean; base?: string }) => {
      const port = Number(cmdOptions.port ?? "0");
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be an integer from 0 to 65535.");
      const render = (): string => {
        const config = loadConfigChecked(cwd);
        const state = buildState(cwd, config);
        let change: GovernanceMapOptions["change"];
        if (cmdOptions.change) {
          const impact = analyzeImpact(cwd, config, state.graph, state.index, state.ownership, state.contexts, {
            ...(cmdOptions.base ? { base: cmdOptions.base } : {}),
          });
          if (!impact.ok) throw impact.error;
          const review = resolveReviewers(cwd, config, impact.value);
          change = {
            decision: buildGovernanceDecision(impact.value, review, "warn"),
            changedNodeIds: impact.value.changedSymbols.flatMap((symbol) => symbol.nodeId ? [symbol.nodeId] : []),
            affectedNodeIds: impact.value.affectedNodeIds,
          };
        }
        return renderGraphHtml(state.graph, { ...(change ? { change } : {}) });
      };
      const live = await startGraphDevServer({ root: cwd, port, openBrowser: cmdOptions.open !== false, render });
      process.stdout.write(`NodeNet live graph: ${live.url}\nWatching for repository changes. Ctrl-C to stop.\n`);
      const stop = (): void => { void live.close().finally(() => process.exit(0)); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });

  // -- changes ---------------------------------------------------------------
  program
    .command("changes")
    .description("Compare local branches for code, context, and ownership collisions")
    .requiredOption("--refs <refs...>", "two or more local branch/ref names")
    .option("--base <ref>", "shared base branch", "main")
    .option("--json", "emit machine-readable JSON")
    .action((cmdOptions: { refs: string[]; base?: string; json?: boolean }) => {
      if (cmdOptions.refs.length < 2) throw new Error("At least two refs are required.");
      const config = loadConfigChecked(cwd);
      const state = loadForAnalysis(cwd, config);
      const report = analyzeChangeCollisions(cwd, cmdOptions.base ?? "main", cmdOptions.refs, state.graph, state.index, state.contexts, state.ownership);
      if (cmdOptions.json) return printJson(report, true);
      process.stdout.write(`Review order: ${report.reviewOrder.join(" → ")}\n`);
      if (!report.collisions.length) process.stdout.write("No cross-change collisions found.\n");
      for (const collision of report.collisions) process.stdout.write(`${collision.severity} ${collision.left} ↔ ${collision.right}: ${collision.reasons.join("; ")}\n`);
    });

  // -- doctor -----------------------------------------------------------------
  program
    .command("doctor")
    .description("Validate configuration, graph, governance readiness and health")
    .option("--json", "emit machine-readable readiness JSON")
    .option("--fix", "safely install missing starter files and the GitHub governance workflow")
    .action((cmdOptions: { json?: boolean; fix?: boolean }) => {
      const fixes = cmdOptions.fix ? bootstrapRepository(cwd, true) : undefined;
      const config = loadConfigChecked(cwd);
      const state = loadForAnalysis(cwd, config);
      const report = computeHealth(state.graph, state.contexts, state.ownership, config);
      const readiness = assessReadiness(cwd, state);
      if (cmdOptions.json) return printJson({ readiness, health: report, warnings: state.warnings, ...(fixes ? { fixes } : {}) }, true);
      if (fixes) {
        for (const file of fixes.created) process.stdout.write(`fixed: ${file}\n`);
        for (const file of fixes.skipped) process.stdout.write(`already present: ${file}\n`);
      }
      process.stdout.write(`config: ok (${state.warnings.length === 0 ? "no warnings" : state.warnings.length + " warnings"})\n`);
      process.stdout.write(`graph: ${state.graph.size} nodes, ${state.graph.edgeCount} edges\n`);
      process.stdout.write(`readiness: ${readiness.score}/100 (${readiness.ready ? "ready" : "needs attention"})\n`);
      for (const check of readiness.checks) {
        process.stdout.write(`  ${check.status.toUpperCase()} ${check.message}${check.action ? ` Next: ${check.action}` : ""}\n`);
      }
      printHealth(report);
    });

  // -- bootstrap --------------------------------------------------------------
  program
    .command("bootstrap")
    .description("Create a safe starter config, LCDD policy, and optional GitHub workflow")
    .option("--github", "also install the GitHub governance workflow")
    .option("--json", "emit machine-readable JSON")
    .action((cmdOptions: { github?: boolean; json?: boolean }) => {
      const result = bootstrapRepository(cwd, cmdOptions.github ?? false);
      if (cmdOptions.json) return printJson(result, true);
      for (const file of result.created) process.stdout.write(`created: ${file}\n`);
      for (const file of result.skipped) process.stdout.write(`skipped (exists): ${file}\n`);
      process.stdout.write("Next: nodenet build && nodenet doctor\n");
    });

  // -- benchmark --------------------------------------------------------------
  program
    .command("benchmark")
    .description("Score a labeled decision dataset for quality and latency")
    .requiredOption("--dataset <file>", "JSON dataset containing expected and actual decisions")
    .option("--json", "emit machine-readable metrics")
    .action((cmdOptions: { dataset: string; json?: boolean }) => {
      const cases = loadBenchmarkCases(path.resolve(cwd, cmdOptions.dataset));
      const metrics = scoreBenchmark(cases);
      if (cmdOptions.json) return printJson(metrics, true);
      process.stdout.write(`cases: ${metrics.cases}\n`);
      process.stdout.write(`reviewer precision: ${(metrics.reviewerPrecision * 100).toFixed(1)}%\n`);
      process.stdout.write(`reviewer recall: ${(metrics.reviewerRecall * 100).toFixed(1)}%\n`);
      process.stdout.write(`false block rate: ${(metrics.falseBlockRate * 100).toFixed(1)}%\n`);
      process.stdout.write(`missed impact rate: ${(metrics.missedImpactRate * 100).toFixed(1)}%\n`);
      process.stdout.write(`outcome accuracy: ${(metrics.outcomeAccuracy * 100).toFixed(1)}%\n`);
      process.stdout.write(`latency p50/p95: ${metrics.p50Ms}ms / ${metrics.p95Ms}ms\n`);
    });

  program
    .command("benchmark-languages")
    .description("Run the executable parser contract benchmark across all ten built-in languages")
    .option("--json", "emit machine-readable benchmark results")
    .action((cmdOptions: { json?: boolean }) => {
      const report = runLanguageBenchmark();
      if (report.passed !== report.cases) commandExitCode = 2;
      if (cmdOptions.json) return printJson(report, true);
      process.stdout.write(`language cases: ${report.passed}/${report.cases} passed (${(report.passRate * 100).toFixed(1)}%)\n`);
      for (const row of report.languages) {
        process.stdout.write(`${row.language.padEnd(12)} ${row.passed}/${row.cases} precision=${row.symbolPrecision} recall=${row.symbolRecall} importRecall=${row.importRecall}\n`);
        for (const failure of row.failures) process.stdout.write(`  - ${failure}\n`);
      }
    });

  program
    .command("benchmark-retrieval")
    .description("Run labeled retrieval tasks against the current graph and MSC engine")
    .requiredOption("--dataset <file>", "retrieval task JSON dataset")
    .option("--json", "emit machine-readable benchmark results")
    .action((cmdOptions: { dataset: string; json?: boolean }) => {
      const config = loadConfigChecked(cwd);
      const state = loadForAnalysis(cwd, config);
      const report = runRetrievalBenchmark(cwd, state, loadRetrievalBenchmark(path.resolve(cwd, cmdOptions.dataset)));
      if (cmdOptions.json) return printJson(report, true);
      process.stdout.write(`retrieval cases: ${report.cases}\nmedian token reduction: ${(report.medianTokenReduction * 100).toFixed(1)}%\nprimary precision/essential recall: ${(report.meanFilePrecision * 100).toFixed(1)}% / ${(report.meanFileRecall * 100).toFixed(1)}%\nuseful precision: ${(report.meanUsefulPrecision * 100).toFixed(1)}% · MRR: ${report.meanReciprocalRank} · nDCG@10: ${report.meanNdcg}\nmandatory context recall: ${(report.mandatoryContextRecall * 100).toFixed(1)}%\n`);
      for (const result of report.results) process.stdout.write(`${result.id}: reduction=${(result.tokenReduction * 100).toFixed(1)}% fileRecall=${(result.fileRecall * 100).toFixed(1)}% contextRecall=${(result.mandatoryContextRecall * 100).toFixed(1)}%\n`);
      if (report.mandatoryContextRecall < 1) commandExitCode = 2;
    });

  program
    .command("benchmark-governance")
    .description("Execute impact, reviewer, and decision engines against labeled git-base scenarios")
    .requiredOption("--dataset <file>", "JSON cases containing base refs and expected decisions")
    .option("--json", "emit machine-readable benchmark results")
    .action((cmdOptions: { dataset: string; json?: boolean }) => {
      const config = loadConfigChecked(cwd);
      const state = loadForAnalysis(cwd, config) as AnalysisState;
      const report = runGovernanceBenchmark(cwd, config, state, loadExecutableGovernanceCases(path.resolve(cwd, cmdOptions.dataset)));
      if (cmdOptions.json) return printJson(report, true);
      process.stdout.write(`governance cases: ${report.metrics.cases}; errors: ${report.errors.length}\nprecision=${report.metrics.reviewerPrecision} recall=${report.metrics.reviewerRecall} falseBlocks=${report.metrics.falseBlockRate} missedImpact=${report.metrics.missedImpactRate} accuracy=${report.metrics.outcomeAccuracy} p95=${report.metrics.p95Ms}ms\n`);
      for (const error of report.errors) process.stdout.write(`  ERROR ${error.id}: ${error.error}\n`);
      if (report.errors.length || report.metrics.outcomeAccuracy < 1 || report.metrics.missedImpactRate > 0) commandExitCode = 2;
    });

  // -- eval -------------------------------------------------------------------
  const evaluation = program.command("eval").description("Import, replay, label and evaluate historical pull requests");
  evaluation
    .command("import-github")
    .description("Import historical GitHub pull-request metadata into a local dataset")
    .requiredOption("--repo <owner/name>", "GitHub repository")
    .option("--since <date>", "only include PRs updated on/after this ISO date")
    .option("--limit <number>", "maximum pull requests", "100")
    .option("--dataset <id>", "dataset identifier")
    .option("--token <token>", "GitHub token (default GITHUB_TOKEN/GH_TOKEN)")
    .action(async (cmdOptions: { repo: string; since?: string; limit?: string; dataset?: string; token?: string }) => {
      const token = cmdOptions.token ?? resolveGitHubToken();
      if (!token) throw new Error("GitHub authentication is required. Set GITHUB_TOKEN/GH_TOKEN or pass --token.");
      const dataset = await importGitHubHistory({ repository: cmdOptions.repo, token, limit: Math.max(1, Number(cmdOptions.limit) || 100), ...(cmdOptions.since ? { since: cmdOptions.since } : {}), ...(cmdOptions.dataset ? { datasetId: cmdOptions.dataset } : {}) });
      const file = saveDataset(cwd, dataset);
      process.stdout.write(`Imported ${dataset.cases.length} pull requests into ${dataset.id}\n${file}\n`);
    });
  evaluation
    .command("run")
    .description("Replay NodeNet against historical base/head commits without executing repository code")
    .requiredOption("--dataset <id>", "dataset identifier")
    .option("--limit <number>", "maximum cases")
    .action((cmdOptions: { dataset: string; limit?: string }) => {
      const dataset = loadDataset(cwd, cmdOptions.dataset);
      const run = replayDataset(cwd, dataset, { ...(cmdOptions.limit ? { limit: Math.max(1, Number(cmdOptions.limit) || 1) } : {}), onProgress: (done, total) => process.stdout.write(`replayed ${done}/${total}\n`) });
      const file = saveEvaluationRun(cwd, run);
      process.stdout.write(`Evaluation run ${run.id} written to ${file}\n`);
    });
  evaluation
    .command("label")
    .description("Open the local blind-labeling Decision Lab")
    .requiredOption("--dataset <id>", "dataset identifier")
    .option("--run <id>", "evaluation run to compare after revealing")
    .option("--no-open", "do not open a browser")
    .option("--port <port>", "loopback port; 0 selects an available port", "0")
    .action(async (cmdOptions: { dataset: string; run?: string; open?: boolean; port?: string }) => {
      const server = await startLabelServer({ root: cwd, dataset: loadDataset(cwd, cmdOptions.dataset), ...(cmdOptions.run ? { run: loadEvaluationRun(cwd, cmdOptions.run) } : {}), port: Number(cmdOptions.port ?? "0"), openBrowser: cmdOptions.open !== false });
      process.stdout.write(`NodeNet Decision Lab: ${server.url}\nCtrl-C to stop.\n`);
      const stop = (): void => { void server.close().finally(() => process.exit(0)); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
  evaluation
    .command("report")
    .description("Compare replay output with human labels")
    .requiredOption("--run <id>", "evaluation run identifier")
    .option("--json", "emit machine-readable report")
    .action((cmdOptions: { run: string; json?: boolean }) => {
      const run = loadEvaluationRun(cwd, cmdOptions.run);
      const report = buildEvaluationReport(run, loadLabels(cwd, run.datasetId));
      if (cmdOptions.json) return printJson(report, true);
      process.stdout.write(`evaluated: ${report.evaluated}/${report.labeled} labeled; errors: ${report.errors}\n`);
      process.stdout.write(`precision ${report.metrics.reviewerPrecision} · recall ${report.metrics.reviewerRecall} · false blocks ${report.metrics.falseBlockRate} · missed hardened ${report.metrics.missedImpactRate} · p95 ${report.metrics.p95Ms}ms\n`);
    });
  evaluation
    .command("gate")
    .description("Fail when a labeled evaluation run misses quality thresholds")
    .requiredOption("--run <id>", "evaluation run identifier")
    .option("--min-precision <value>", "minimum reviewer precision", "0.8")
    .option("--min-recall <value>", "minimum reviewer recall", "0.75")
    .option("--max-false-block <value>", "maximum false-block rate", "0.05")
    .option("--max-missed-hardened <value>", "maximum missed-hardened rate", "0")
    .action((cmdOptions: { run: string; minPrecision: string; minRecall: string; maxFalseBlock: string; maxMissedHardened: string }) => {
      const run = loadEvaluationRun(cwd, cmdOptions.run);
      const report = buildEvaluationReport(run, loadLabels(cwd, run.datasetId));
      const gate = evaluationGate(report, { minPrecision: Number(cmdOptions.minPrecision), minRecall: Number(cmdOptions.minRecall), maxFalseBlock: Number(cmdOptions.maxFalseBlock), maxMissedHardened: Number(cmdOptions.maxMissedHardened) });
      process.stdout.write(gate.pass ? "Evaluation gate passed.\n" : `Evaluation gate failed:\n${gate.failures.map((item) => `  - ${item}`).join("\n")}\n`);
      if (!gate.pass) commandExitCode = 2;
    });

  // -- github pr --------------------------------------------------------------
  withJson(
    program
      .command("github")
      .description("GitHub pull-request integration")
      .command("pr")
      .description("Analyze a PR and optionally comment / request reviewers")
      .option("-r, --repo <owner/name>", "repository, e.g. owner/name (or GITHUB_REPOSITORY)")
      .option("-p, --pr <number>", "pull request number (or GITHUB_PR_NUMBER / GITHUB_REF)")
      .option("-b, --base <ref>", "base branch (default: GITHUB_BASE_REF or main)")
      .option("--comment", "post the impact + review comment to the PR")
      .option("--request-reviewers", "request required/authority reviewers on the PR")
      .option("--check", "create or update the NodeNet GitHub Check Run")
      .option("--sha <sha>", "head commit SHA (or GITHUB_SHA)")
      .option("--mode <mode>", "governance rollout mode: observe, warn, or enforce", "warn")
      .option("--token <token>", "GitHub token (default: GITHUB_TOKEN)")
      .option("--override-decision <id>", "override this exact deterministic decision ID")
      .option("--override-actor <actor>", "identity authorizing the override")
      .option("--override-reason <reason>", "required override justification")
      .option("--override-expires <iso>", "required ISO-8601 override expiry")
      .action(async (cmdOptions: {
        json?: boolean;
        repo?: string;
        pr?: string;
        base?: string;
        comment?: boolean;
        requestReviewers?: boolean;
        check?: boolean;
        sha?: string;
        token?: string;
        mode?: string;
        overrideDecision?: string;
        overrideActor?: string;
        overrideReason?: string;
        overrideExpires?: string;
      }) => {
        const config = loadConfigChecked(cwd);
        const state = loadForAnalysis(cwd, config) as AnalysisState;
        const repo = cmdOptions.repo ?? process.env["GITHUB_REPOSITORY"];
        if (!repo) {
          process.stdout.write("Repository not provided. Pass --repo owner/name or set GITHUB_REPOSITORY.\n");
          return;
        }
        let pr: number | undefined;
        try { pr = resolvePullNumber(cmdOptions.pr); } catch {
          if (cmdOptions.comment || cmdOptions.requestReviewers) throw new Error("A pull request number is required for comments or reviewer requests.");
        }
        const base = cmdOptions.base ?? process.env["GITHUB_BASE_REF"] ?? "main";
        const mode = cmdOptions.mode ?? "warn";
        if (!isGovernanceMode(mode)) {
          throw new Error(`Invalid governance mode "${mode}". Use observe, warn, or enforce.`);
        }
        let override: DecisionOverride | undefined;
        const overrideValues = [cmdOptions.overrideDecision, cmdOptions.overrideActor, cmdOptions.overrideReason, cmdOptions.overrideExpires];
        if (overrideValues.some(Boolean)) {
          if (overrideValues.some((value) => !value)) throw new Error("Override requires --override-decision, --override-actor, --override-reason and --override-expires.");
          const token = cmdOptions.token ?? process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
          const verifiedActor = await resolveGitHubIdentity(token);
          if (process.env["GITHUB_ACTIONS"] === "true" && !verifiedActor) throw new Error("Cannot verify the GitHub actor for this override.");
          override = {
            decisionId: cmdOptions.overrideDecision ?? "",
            actor: verifiedActor?.login ?? cmdOptions.overrideActor ?? "",
            reason: cmdOptions.overrideReason ?? "",
            createdAt: new Date().toISOString(),
            expiresAt: cmdOptions.overrideExpires ?? "",
            identityAssurance: verifiedActor?.assurance ?? "claimed",
            ...(verifiedActor ? { verifiedActor } : {}),
          };
        }
        const result = await runPrIntegration(cwd, config, state, {
          repo,
          ...(pr !== undefined ? { pr } : {}),
          base,
          comment: cmdOptions.comment ?? false,
          requestReviewers: cmdOptions.requestReviewers ?? false,
          ...(cmdOptions.token !== undefined ? { token: cmdOptions.token } : {}),
          enforcePolicy: true,
          mode: mode as GovernanceMode,
          check: cmdOptions.check ?? false,
          ...((cmdOptions.sha ?? process.env["GITHUB_SHA"]) ? { headSha: cmdOptions.sha ?? process.env["GITHUB_SHA"] ?? "" } : {}),
          ...(override ? { override } : {}),
        });
        if (!result.ok) {
          process.stdout.write(`GitHub PR analysis failed: ${result.error.message}\n`);
          return;
        }
        if (cmdOptions.json) {
          printJson(
            {
              decision: result.value.decision,
              commentPosted: result.value.commentPosted,
              requestedReviewers: result.value.requestedReviewers,
              requestedTeams: result.value.requestedTeams,
              checkUpdated: result.value.checkUpdated,
            },
            true,
          );
          if (result.value.decision.shouldFail) commandExitCode = 2;
          return;
        }
        process.stdout.write(result.value.comment + "\n");
        if (result.value.commentPosted) process.stdout.write("Comment posted to the pull request.\n");
        const requested = [...result.value.requestedReviewers, ...result.value.requestedTeams];
        if (requested.length > 0) {
          process.stdout.write(`Reviewers requested: ${requested.join(", ")}\n`);
        }
        process.stdout.write(`Governance decision: ${result.value.decision.outcome.toUpperCase()} (${result.value.decision.mode})\n`);
        if (result.value.decision.shouldFail) commandExitCode = 2;
      }),
  );

  // -- mcp --------------------------------------------------------------------
  program
    .command("mcp")
    .description("Run the MCP server over stdio (Model Context Protocol)")
    .option("--tools <preset>", "tool preset: core, governance, or all", "core")
    .action(async (cmdOptions: { tools?: string }) => {
      const toolPreset = cmdOptions.tools ?? "core";
      if (!["core", "governance", "all"].includes(toolPreset)) throw new Error("--tools must be core, governance, or all.");
      const config = loadConfigChecked(cwd);
      const state = loadForAnalysis(cwd, config) as AnalysisState;
      const ctx = prepareMcpContext({ root: cwd, config, state, protocolState: { initialized: false, ready: false, shutdownRequested: false }, auditEnabled: true, toolPreset: toolPreset as "core" | "governance" | "all" });
      const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of rl) {
        const response = handleMcpLine(ctx, line);
        if (response !== null) process.stdout.write(response + "\n");
        if (ctx.protocolState?.shutdownRequested) break;
      }
    });

  program
    .command("audit-verify")
    .description("Verify the tamper-evident hash chain in .nodenet/audit.jsonl")
    .option("--json", "emit machine-readable JSON")
    .action((cmdOptions: { json?: boolean }) => {
      const verification = verifyAuditChain(cwd);
      if (cmdOptions.json) printJson(verification, true);
      else process.stdout.write(verification.valid
        ? `Audit chain valid: ${verification.verifiedRecords} verified record(s), ${verification.legacyRecords} legacy record(s).\n`
        : `Audit chain INVALID at line ${verification.errorLine ?? "unknown"}: ${verification.message ?? "verification failed"}\n`);
      if (!verification.valid) commandExitCode = 2;
    });

  // -- serve ------------------------------------------------------------------
  program
    .command("serve")
    .description("Serve standards-compliant MCP Streamable HTTP with scoped, loopback-first access")
    .option("--host <host>", "bind host; loopback is the safe default", "127.0.0.1")
    .option("--port <port>", "bind port", "7341")
    .option("--token <token>", "optional bearer token")
    .option("--scopes <scopes>", "comma-separated token scopes (graph:read, context:read, impact:read, governance:read, health:read)")
    .option("--rate-capacity <count>", "per-credential token-bucket capacity", "60")
    .option("--rate-refill <count>", "tokens replenished per second", "10")
    .option("--reload-interval <ms>", "stale-state check interval for atomic reload", "2000")
    .option("--no-reload", "disable automatic atomic snapshot reload")
    .option("--tools <preset>", "tool preset: core, governance, or all", "core")
    .action(async (cmdOptions: { host?: string; port?: string; token?: string; scopes?: string; rateCapacity?: string; rateRefill?: string; reloadInterval?: string; reload?: boolean; tools?: string }) => {
      const config = loadConfigChecked(cwd);
      const state = loadForAnalysis(cwd, config) as AnalysisState;
      const port = Number(cmdOptions.port ?? "7341");
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be an integer from 0 to 65535.");
      const host = cmdOptions.host ?? "127.0.0.1";
      const toolPreset = cmdOptions.tools ?? "core";
      if (!["core", "governance", "all"].includes(toolPreset)) throw new Error("--tools must be core, governance, or all.");
      if (host !== "127.0.0.1" && host !== "::1" && !cmdOptions.token) {
        throw new Error("A bearer token is required when binding beyond loopback.");
      }
      if (cmdOptions.scopes && !cmdOptions.token) throw new Error("--scopes requires --token.");
      const scopes = (cmdOptions.scopes?.split(",").map((value) => value.trim()).filter(Boolean) ?? [...MCP_SCOPES]) as McpScope[];
      if (scopes.length === 0 || scopes.some((scope) => !(MCP_SCOPES as readonly string[]).includes(scope))) {
        throw new Error(`Invalid MCP scope. Valid scopes: ${MCP_SCOPES.join(", ")}.`);
      }
      const rateCapacity = Number(cmdOptions.rateCapacity ?? "60");
      const rateRefillPerSecond = Number(cmdOptions.rateRefill ?? "10");
      const reloadIntervalMs = Number(cmdOptions.reloadInterval ?? "2000");
      if (!Number.isInteger(rateCapacity) || rateCapacity < 1) throw new Error("--rate-capacity must be a positive integer.");
      if (!Number.isFinite(rateRefillPerSecond) || rateRefillPerSecond <= 0) throw new Error("--rate-refill must be positive.");
      if (cmdOptions.reload !== false && (!Number.isInteger(reloadIntervalMs) || reloadIntervalMs < 250)) throw new Error("--reload-interval must be an integer of at least 250ms.");
      const server = await startMcpHttpServer({ root: cwd, config, state, protocolState: { initialized: false, ready: false, shutdownRequested: false }, auditEnabled: true, toolPreset: toolPreset as "core" | "governance" | "all" }, {
        host,
        port,
        ...(cmdOptions.token ? { credentials: [{ token: cmdOptions.token, scopes, repositoryRoot: cwd }] } : {}),
        rateLimit: { capacity: rateCapacity, refillPerSecond: rateRefillPerSecond },
        ...(cmdOptions.reload !== false ? {
          reload: {
            intervalMs: reloadIntervalMs,
            load: async () => {
              const nextConfig = loadConfigChecked(cwd);
              return { config: nextConfig, state: buildState(cwd, nextConfig) };
            },
          },
        } : {}),
      });
      process.stdout.write(`NodeNet MCP Streamable HTTP listening at ${server.url}/mcp\n`);
      await new Promise<void>((resolve) => {
        const stop = () => void server.close().then(resolve);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    });

  // -- install / uninstall ----------------------------------------------------
  program
    .command("languages")
    .description("Show built-in language support tiers and extraction capabilities")
    .option("--json", "emit machine-readable JSON")
    .action((cmdOptions: { json?: boolean }) => {
      const matrix = languageSupportMatrix();
      if (cmdOptions.json) return printJson(matrix, true);
      for (const item of matrix) process.stdout.write(`${item.tier.toUpperCase().padEnd(5)} ${item.language.padEnd(12)} ${item.capabilities.join(", ")}\n`);
    });

  program
    .command("install")
    .description("Install project-local query-first guidance for a coding agent")
    .requiredOption("--platform <platform>", `platform: ${AGENT_PLATFORMS.join(", ")}`)
    .action((cmdOptions: { platform: string }) => {
      if (!AGENT_PLATFORMS.includes(cmdOptions.platform as AgentPlatform)) throw new Error(`Unknown platform: ${cmdOptions.platform}`);
      const result = installAgentGuidance(cwd, cmdOptions.platform as AgentPlatform);
      if (!result.ok) throw result.error;
      process.stdout.write(`NodeNet guidance installed in ${result.value}\n`);
    });

  program
    .command("uninstall")
    .description("Remove project-local NodeNet agent guidance")
    .requiredOption("--platform <platform>", `platform: ${AGENT_PLATFORMS.join(", ")}`)
    .action((cmdOptions: { platform: string }) => {
      if (!AGENT_PLATFORMS.includes(cmdOptions.platform as AgentPlatform)) throw new Error(`Unknown platform: ${cmdOptions.platform}`);
      const result = uninstallAgentGuidance(cwd, cmdOptions.platform as AgentPlatform);
      if (!result.ok) throw result.error;
      process.stdout.write(`NodeNet guidance removed from ${result.value}\n`);
    });

  program.exitOverride();

  try {
    await program.parseAsync(argv, { from: "user" });
    return commandExitCode;
  } catch (e) {
    // help/version output is not an error
    if (typeof e === "object" && e !== null && "exitCode" in e && (e as { exitCode: number }).exitCode === 0) {
      return 0;
    }
    process.stderr.write(`error: ${errorMessage(e)}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Printing helpers
// ---------------------------------------------------------------------------

function loadConfigChecked(cwd: string): LoadedConfig {
  const config = loadConfig(cwd);
  if (!config.ok) {
    throw new Error(`Configuration error: ${config.error.message}. Fix nodenet.config.json or run \`nodenet init\`.`);
  }
  return config.value;
}

function resolveTargetPath(graph: Graph, index: CodeGraphIndex, target: string): SafeRelativePath | undefined {
  const asSafe = safeRelativePath(target);
  if (asSafe.ok && index.fileNodes.has(asSafe.value)) return asSafe.value;
  const node = findNodeByName(graph, target);
  if (!node) return undefined;
  if (node.kind === "file") return (node as { path: SafeRelativePath }).path;
  if ("path" in node && typeof node.path === "string") {
    const safe = safeRelativePath(node.path);
    if (safe.ok) return safe.value;
  }
  return undefined;
}


function printImpact(impact: ImpactReport, json: boolean): void {
  if (json) {
    printJson(
      {
        severity: impact.severity,
        severityReasons: impact.severityReasons,
        crossTeamBoundary: impact.crossTeamBoundary,
        changedFiles: impact.changedFiles.map((f) => f.toString()),
        changedSymbols: impact.changedSymbols,
        affectedFiles: impact.affectedFiles.map((f) => f.toString()),
        approvalFiles: impact.approvalFiles.map((f) => f.toString()),
        affectedContexts: impact.affectedContexts.map((c) => c.id),
        directContexts: impact.directContexts.map((c) => c.id),
        transitiveContexts: impact.transitiveContexts.map((c) => c.id),
        boundaries: impact.boundaries,
        owners: impact.owners,
      },
      true,
    );
    return;
  }
  process.stdout.write(`## NodeNet Impact Analysis\n\n`);
  process.stdout.write(`Changed files: ${impact.changedFiles.map((f) => f.toString()).join(", ") || "none"}\n`);
  process.stdout.write(`Changed symbols:\n`);
  for (const s of impact.changedSymbols) {
    process.stdout.write(`  ${s.changeKind.toUpperCase()} ${s.symbolName} (${s.relPath.toString()}:${s.startLine})\n`);
  }
  process.stdout.write(`\nImpact: ${impact.severity}\n`);
  for (const reason of impact.severityReasons) process.stdout.write(`  reason: ${reason}\n`);
  if (impact.crossTeamBoundary) {
    process.stdout.write(`\nOwnership boundary crossed:\n`);
    for (const b of impact.boundaries) {
      process.stdout.write(`  ${b.fromTeam} → ${b.toTeam} (via ${b.viaFile})\n`);
    }
  }
  if (impact.affectedContexts.length > 0) {
    process.stdout.write(`\nAffected living context:\n`);
    for (const ctx of impact.affectedContexts) {
      process.stdout.write(
        `  ${ctx.id} [${ctx.status}] ${ctx.authority} — ${ctx.title} (approvers: ${ctx.approvedBy.join(", ") || "none"})\n`,
      );
    }
  }
  process.stdout.write(`\nOwnership:\n`);
  for (const o of impact.owners) {
    process.stdout.write(`  ${o.file} → ${o.owner} (${o.source}, ${o.confidence.toLowerCase()})\n`);
  }
}

function printReview(review: ReviewResolution, impact: ImpactReport): void {
  process.stdout.write(`## NodeNet Review Resolution\n\n`);
  process.stdout.write(`Severity: ${impact.severity}\n`);
  const printGroup = (title: string, items: ReviewResolution["suggested"]): void => {
    if (items.length === 0) return;
    process.stdout.write(`\n${title}:\n`);
    for (const item of items) {
      process.stdout.write(`  ${item.target}\n`);
      for (const reason of item.reasons) process.stdout.write(`    because: ${reason}\n`);
    }
  };
  printGroup("Suggested", review.suggested);
  printGroup("Required", review.required);
  printGroup("Authority approval required", review.authorityRequired);
  printGroup("Informational (transitive only)", review.informational);
  if (review.suggested.length + review.required.length + review.authorityRequired.length + review.informational.length === 0) {
    process.stdout.write("No reviewers required.\n");
  }
}

function printBundle(bundle: ContextBundle): void {
  process.stdout.write(`TARGET\n  ${bundle.target}\n`);
  process.stdout.write(`  context budget: ~${bundle.metrics.estimatedTokens}/${bundle.metrics.budgetTokens} tokens${bundle.metrics.truncated ? " (truncated)" : ""}\n`);
  if (bundle.codeEvidence.length > 0) {
    process.stdout.write(`\nCODE CONTEXT\n`);
    for (const evidence of bundle.codeEvidence) process.stdout.write(`  ${evidence.label}\n`);
  }
  if (bundle.sourceEvidence.length > 0) {
    process.stdout.write(`\nSOURCE EVIDENCE\n`);
    for (const evidence of bundle.sourceEvidence) {
      process.stdout.write(`  ${evidence.path}:${evidence.startLine}-${evidence.endLine}\n`);
      process.stdout.write(evidence.text.split("\n").map((line) => `    ${line}`).join("\n") + "\n");
    }
  }
  if (bundle.livingContext.length > 0) {
    process.stdout.write(`\nLIVING CONTEXT\n`);
    for (const ctx of bundle.livingContext) {
      process.stdout.write(`  ${ctx.id} [${ctx.status}] ${ctx.authority} — ${ctx.title}\n`);
    }
  }
  process.stdout.write(`\nOWNERSHIP\n`);
  for (const o of bundle.ownership) process.stdout.write(`  ${o.file}: ${o.owner}\n`);
  if (bundle.ownership.length === 0) process.stdout.write(`  (none declared)\n`);
  process.stdout.write(`\nAUTHORITY\n`);
  for (const a of bundle.authority) {
    process.stdout.write(`  ${a.contextId}: ${a.approvers.join(", ")}\n`);
  }
  if (bundle.authority.length === 0) process.stdout.write(`  (none declared)\n`);
  process.stdout.write(`\nCHANGE BOUNDARIES\n`);
  for (const b of bundle.changeBoundaries) process.stdout.write(`  ${b}\n`);
  if (bundle.changeBoundaries.length === 0) process.stdout.write(`  (none declared)\n`);
  process.stdout.write(`\nAI GUIDANCE\n`);
  for (const g of bundle.aiGuidance) {
    process.stdout.write(`  - ${g.action}\n    why: ${g.why}\n`);
  }
  if (bundle.secretFlagged) {
    process.stdout.write(`\nWARNING: secret-like values detected in this bundle; review before sharing.\n`);
  }
}

function printHealth(report: HealthReport, showUncovered = false): void {
  process.stdout.write(`## NodeNet Context Health\n`);
  process.stdout.write(`Timestamp: ${report.timestamp}\n`);
  process.stdout.write(`Context artifacts: ${report.contexts.total}\n`);
  for (const [status, count] of Object.entries(report.contexts.byStatus)) {
    if (count) process.stdout.write(`  ${status}: ${count}\n`);
  }
  if (report.contexts.conflicts > 0) process.stdout.write(`  conflicts: ${report.contexts.conflicts}\n`);
  if (report.contexts.orphan > 0) process.stdout.write(`  orphan: ${report.contexts.orphan}\n`);
  process.stdout.write(`Ownership coverage: ${report.ownershipCoverage}%\n`);
  process.stdout.write(`Authority coverage: ${report.authorityCoverage}%\n`);
  if (showUncovered) {
    process.stdout.write(`Uncovered files (${report.unownedFiles.length}):\n`);
    for (const file of report.unownedFiles) process.stdout.write(`  ${file}\n`);
  }
  if (report.warnings.length > 0) {
    process.stdout.write(`\nWarnings:\n`);
    for (const w of report.warnings) process.stdout.write(`  - ${w}\n`);
  }
}

// Entry point when executed as a bin. Uses realpath so globally-installed
// (symlinked) bins still trigger the CLI (spec §54).
const isMain = ((): boolean => {
  const arg1 = process.argv[1];
  if (!arg1) return false;
  try {
    return import.meta.url === `file://${fs.realpathSync(arg1)}`;
  } catch {
    return false;
  }
})();
if (isMain) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
