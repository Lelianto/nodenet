#!/usr/bin/env node
/**
 * NodeNet CLI (NodeNet spec §54).
 *
 * Commands: init, build, update, watch, query, related, trace, context,
 * explain, owner, governed-by, impact, reviewers, conflicts, health,
 * graph, doctor. Machine-readable output via --json where appropriate.
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
} from "../storage/storage.js";
import type { Graph } from "../graph/graph.js";
import type { GraphNode } from "../graph/nodes.js";
import { nodeLabel } from "../graph/nodes.js";
import { findPath, neighbors } from "../graph/traversal.js";
import { analyzeImpact, type ImpactReport } from "../change/impact.js";
import { resolveReviewers, type ReviewResolution } from "../review/resolver.js";
import { computeHealth, type HealthReport } from "../health/health.js";
import { buildContextBundle, type ContextBundle } from "../ai/context-builder.js";
import { renderGraphHtml } from "../visualization/html.js";
import { renderGraphSvg } from "../visualization/svg.js";
import { safeRelativePath, type SafeRelativePath } from "../security/filesystem.js";
import { errorMessage } from "../types/result.js";
import { matchGlob } from "../utils/glob.js";
import type { ContextRecord } from "../context/schema.js";
import type { OwnershipIndex } from "../ownership/resolver.js";
import type { ParsedSymbol, ParsedSymbolKind } from "../parser/typescript.js";
import { runPrIntegration } from "../github/github.js";
import { resolvePullNumber } from "../github/client.js";
import { handleMcpLine, type McpContext } from "../mcp/server.js";
import type { AnalysisState } from "../types/analysis-state.js";

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
  const build = buildCodeGraph(root, config);
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

function printJson(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  }
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function runCli(argv: string[], opts: { cwd?: string } = {}): Promise<number> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const program = new Command();
  program
    .name("nodenet")
    .description("NodeNet maps code, context, ownership, and authority into an explainable graph.")
    .version("0.3.0");

  const withJson = (cmd: Command): Command => cmd.option("--json", "machine-readable JSON output");

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
        `Updated: ${changed.length} modified, ${added.length} added, ${removed.length} removed.\n`,
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
        const matches = graph.queryByName(name).slice(0, 200);
        if (cmdOptions.json) {
          printJson(matches.map(nodeToRecord), true);
          return;
        }
        for (const node of matches) process.stdout.write(`${humanNode(node)}\n`);
        if (matches.length === 0) process.stdout.write("No matches.\n");
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
      .action((target: string | undefined, cmdOptions: { json?: boolean; propose?: string }) => {
        const config = loadConfigChecked(cwd);
        const state = loadForAnalysis(cwd, config);
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
        const bundle = buildContextBundle(state.graph, state.index, state.ownership, state.contexts, target);
        if (!bundle) {
          process.stdout.write(`No target matched "${target}". Try a symbol or file name.\n`);
          return;
        }
        if (cmdOptions.json) {
          printJson(bundle, true);
          return;
        }
        printBundle(bundle);
      }),
  );

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
      .action((target: string, cmdOptions: { json?: boolean }) => {
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
        if (cmdOptions.json) {
          printJson({ file: filePath.toString(), ...resolution }, true);
          return;
        }
        process.stdout.write(
          `${filePath.toString()} → ${resolution.owner} (source: ${resolution.source}, confidence: ${resolution.confidence})\n`,
        );
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
      .action((cmdOptions: { json?: boolean }) => {
        const config = loadConfigChecked(cwd);
        const state = loadForAnalysis(cwd, config);
        const report = computeHealth(state.graph, state.contexts, state.ownership, config);
        if (cmdOptions.json) {
          printJson(report, true);
          return;
        }
        printHealth(report);
      }),
  );

  // -- graph ------------------------------------------------------------------
  program
    .command("graph")
    .description("Generate an interactive HTML or static SVG visualization")
    .option("-o, --output <file>", "output file (default .nodenet/graph.html)")
    .option("-f, --format <format>", "output format: html (interactive) or svg (static image)", "html")
    .action((cmdOptions: { output?: string; format?: string }) => {
      const config = loadConfigChecked(cwd);
      const state = loadForAnalysis(cwd, config);
      const format = cmdOptions.format ?? "html";
      if (format !== "html" && format !== "svg") {
        process.stdout.write(`Unknown format "${format}". Use html or svg.\n`);
        return;
      }
      const out = cmdOptions.output ?? path.join(cwd, ".nodenet", format === "svg" ? "graph.svg" : "graph.html");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const content = format === "svg" ? renderGraphSvg(state.graph) : renderGraphHtml(state.graph);
      fs.writeFileSync(out, content);
      process.stdout.write(`Graph written to ${out}\n`);
    });

  // -- doctor -----------------------------------------------------------------
  program
    .command("doctor")
    .description("Validate configuration, graph and health")
    .action(() => {
      const config = loadConfigChecked(cwd);
      const state = loadForAnalysis(cwd, config);
      const report = computeHealth(state.graph, state.contexts, state.ownership, config);
      process.stdout.write(`config: ok (${state.warnings.length === 0 ? "no warnings" : state.warnings.length + " warnings"})\n`);
      process.stdout.write(`graph: ${state.graph.size} nodes, ${state.graph.edgeCount} edges\n`);
      printHealth(report);
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
      .option("--token <token>", "GitHub token (default: GITHUB_TOKEN)")
      .action(async (cmdOptions: {
        json?: boolean;
        repo?: string;
        pr?: string;
        base?: string;
        comment?: boolean;
        requestReviewers?: boolean;
        token?: string;
      }) => {
        const config = loadConfigChecked(cwd);
        const state = loadForAnalysis(cwd, config) as AnalysisState;
        const repo = cmdOptions.repo ?? process.env["GITHUB_REPOSITORY"];
        if (!repo) {
          process.stdout.write("Repository not provided. Pass --repo owner/name or set GITHUB_REPOSITORY.\n");
          return;
        }
        const pr = resolvePullNumber(cmdOptions.pr);
        const base = cmdOptions.base ?? process.env["GITHUB_BASE_REF"] ?? "main";
        const result = await runPrIntegration(cwd, config, state, {
          repo,
          pr,
          base,
          comment: cmdOptions.comment ?? false,
          requestReviewers: cmdOptions.requestReviewers ?? false,
          ...(cmdOptions.token !== undefined ? { token: cmdOptions.token } : {}),
          enforcePolicy: true,
        });
        if (!result.ok) {
          process.stdout.write(`GitHub PR analysis failed: ${result.error.message}\n`);
          return;
        }
        if (cmdOptions.json) {
          printJson(
            {
              severity: result.value.impact.severity,
              severityReasons: result.value.impact.severityReasons,
              commentPosted: result.value.commentPosted,
              requestedReviewers: result.value.requestedReviewers,
              requestedTeams: result.value.requestedTeams,
            },
            true,
          );
          return;
        }
        process.stdout.write(result.value.comment + "\n");
        if (result.value.commentPosted) process.stdout.write("Comment posted to the pull request.\n");
        const requested = [...result.value.requestedReviewers, ...result.value.requestedTeams];
        if (requested.length > 0) {
          process.stdout.write(`Reviewers requested: ${requested.join(", ")}\n`);
        }
      }),
  );

  // -- mcp --------------------------------------------------------------------
  program
    .command("mcp")
    .description("Run the MCP server over stdio (Model Context Protocol)")
    .action(async () => {
      const config = loadConfigChecked(cwd);
      const state = loadForAnalysis(cwd, config) as AnalysisState;
      const ctx: McpContext = { root: cwd, config, state };
      const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of rl) {
        const response = handleMcpLine(ctx, line);
        if (response !== null) process.stdout.write(response + "\n");
      }
    });

  program.exitOverride();

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
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
        affectedContexts: impact.affectedContexts.map((c) => c.id),
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
  if (review.suggested.length + review.required.length + review.authorityRequired.length === 0) {
    process.stdout.write("No reviewers required.\n");
  }
}

function printBundle(bundle: ContextBundle): void {
  process.stdout.write(`TARGET\n  ${bundle.target}\n`);
  if (bundle.codeContext.length > 0) {
    process.stdout.write(`\nCODE CONTEXT\n`);
    for (const c of bundle.codeContext) process.stdout.write(`  ${c}\n`);
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

function printHealth(report: HealthReport): void {
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
