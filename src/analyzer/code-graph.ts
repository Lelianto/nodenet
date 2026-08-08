/**
 * Code graph analyzer (NodeNet spec §4, §49, §51).
 *
 * Builds the unified graph from scanned + parsed files. Cross-file symbol
 * resolution uses an explicit import/export table (deterministic, no type
 * checker), producing explainable CALLS / USES / REFERENCES / RENDERS /
 * EXTENDS / IMPLEMENTS / TESTS / IMPORTS / EXPORTS edges.
 *
 * Afterwards `attachGovernanceLayers` merges the Living Context and
 * ownership layers into the same graph (spec §3: one coherent graph).
 */

import fs from "node:fs";
import path from "node:path";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import { brand, type NodeId, type EdgeId } from "../types/brand.js";
import { safeRelativePath, dirnameSafe, basenameSafe, type SafeRelativePath } from "../security/filesystem.js";
import { scanRepository, readScannedFile, type ScanEntry } from "../scanner/scanner.js";
import { isTestFile, isConfigFile, type ParsedFile, type ParsedSymbol } from "../parser/typescript.js";
import { parseWithLanguageAdapter, supportedByLanguageAdapter } from "../parser/registry.js";
import type { LoadedConfig } from "../config/config.js";
import { Graph } from "../graph/graph.js";
import type { GraphNode } from "../graph/nodes.js";
import {
  DirectoryNode,
  FileNode,
  ApiRouteNode,
  MiddlewareNode,
  TestNode,
  ConfigurationNode,
  RepositoryNode,
  WorkspaceNode,
  PackageNode,
} from "../graph/nodes.js";
import { type GraphEdge, type Relation, type EdgeProvenance } from "../graph/edges.js";
import { loadParseCache, saveParseCache, type CachedParse } from "../parser/cache.js";
import { attachRepositoryArtifacts } from "./artifacts.js";

// ---------------------------------------------------------------------------
// Index produced alongside the graph (used by impact analysis etc.)
// ---------------------------------------------------------------------------

export interface CodeGraphIndex {
  fileNodes: Map<SafeRelativePath, NodeId>;
  parsedFiles: Map<SafeRelativePath, ParsedFile>;
  /** display name -> node ids, per file */
  symbolsByFile: Map<SafeRelativePath, Map<string, NodeId[]>>;
  /** exported display name -> node ids, per file */
  exportedByFile: Map<SafeRelativePath, Map<string, NodeId[]>>;
  /** in-repo package name -> package dir */
  packageDirByName: Map<string, SafeRelativePath>;
  packageNodeByDir: Map<SafeRelativePath, NodeId>;
}

export interface CodeBuildResult {
  graph: Graph;
  index: CodeGraphIndex;
  warnings: string[];
  incremental: { parsed: number; reused: number };
}

// ---------------------------------------------------------------------------
// Node/edge id construction
// ---------------------------------------------------------------------------

const SEP = "\u0000";

export function makeNodeId(...parts: string[]): NodeId {
  return brand<string, "NodeId">(parts.join(SEP));
}

export function makeEdgeId(from: NodeId, relation: string, to: NodeId): EdgeId {
  return brand<string, "EdgeId">(`${from}${SEP}${relation}${SEP}${to}`);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildCodeGraph(root: string, config: LoadedConfig, options: { incrementalCache?: boolean } = {}): Result<CodeBuildResult, Error> {
  const warnings: string[] = [];
  const previousParseCache = options.incrementalCache ? loadParseCache(root) : new Map<string, CachedParse>();
  const nextParseCache = new Map<string, CachedParse>();
  let parsedCount = 0;
  let reusedCount = 0;
  const scan = scanRepository(root, config);
  if (!scan.ok) return err(scan.error);
  warnings.push(...scan.value.warnings);

  const graph = new Graph({
    maxNodes: config.limits.maxGraphNodes,
    maxEdges: config.limits.maxGraphEdges,
  });

  const index: CodeGraphIndex = {
    fileNodes: new Map(),
    parsedFiles: new Map(),
    symbolsByFile: new Map(),
    exportedByFile: new Map(),
    packageDirByName: new Map(),
    packageNodeByDir: new Map(),
  };

  // -- repository + workspace ------------------------------------------------
  const rootAbs = fs.realpathSync(root);
  const repoNode: RepositoryNode = {
    kind: "repository",
    id: makeNodeId("repository", "root"),
    name: path.basename(rootAbs) || "repository",
    root: rootAbs,
  };
  graph.addNode(repoNode);
  const workspaceNode: WorkspaceNode = { kind: "workspace", id: makeNodeId("workspace", "root"), name: "root" };
  graph.addNode(workspaceNode);
  addEdge(graph, workspaceNode.id, repoNode.id, "contains", { source: "ast" });

  // -- packages ---------------------------------------------------------------
  const rootPackageJson = scan.value.packageJsonPaths.find((p) => p.toString() === "package.json");
  if (rootPackageJson) {
    const pkg = readPackageJson(root, rootPackageJson);
    const pkgNode: PackageNode = {
      kind: "package",
      id: makeNodeId("package", "package.json"),
      name: pkg?.name ?? "root-package",
      external: false,
    };
    graph.addNode(pkgNode);
    addEdge(graph, workspaceNode.id, pkgNode.id, "contains", { source: "ast" });
    index.packageNodeByDir.set("" as SafeRelativePath, pkgNode.id);
    if (pkg?.name) index.packageDirByName.set(pkg.name, "" as SafeRelativePath);
  }

  for (const pkgPath of scan.value.packageJsonPaths) {
    if (pkgPath.toString() === "package.json") continue;
    const pkg = readPackageJson(root, pkgPath);
    const pkgDir = dirnameSafe(pkgPath);
    const name = pkg?.name ?? basenameSafe(pkgDir);
    const pkgNode: PackageNode = {
      kind: "package",
      id: makeNodeId("package", pkgDir.toString()),
      name,
      external: false,
      ...(pkgDir.toString() !== "" ? { path: pkgDir } : {}),
    };
    graph.addNode(pkgNode);
    addEdge(graph, workspaceNode.id, pkgNode.id, "contains", { source: "ast" });
    index.packageNodeByDir.set(pkgDir, pkgNode.id);
    index.packageDirByName.set(name, pkgDir);
  }

  // -- files ------------------------------------------------------------------
  // Two-phase build: PASS 1 creates every node (all endpoints must exist
  // before edges are added), PASS 2 adds all edges. This guarantees
  // cross-file edges are never dropped for forward references.
  const knownFiles = new Set<SafeRelativePath>();
  for (const entry of scan.value.files) knownFiles.add(entry.relPath);

  for (const entry of scan.value.files) {
    if (isConfigFile(entry.relPath) && !supportedByLanguageAdapter(entry.relPath)) {
      addConfigNode(graph, index, entry.relPath);
    }
  }

  interface PendingFile {
    entry: ScanEntry;
    parsed: ParsedFile;
  }
  const pending: PendingFile[] = [];

  for (const entry of scan.value.files) {
    if (isConfigFile(entry.relPath) && !supportedByLanguageAdapter(entry.relPath)) continue;
    if (!supportedByLanguageAdapter(entry.relPath)) continue;

    const stat = fs.statSync(entry.absPath);
    const cached = previousParseCache.get(entry.relPath.toString());
    let parsed: ParsedFile;
    if (cached && cached.size === entry.size && cached.mtimeMs === stat.mtimeMs) {
      parsed = cached.parsed;
      reusedCount++;
    } else {
      const contentResult = readScannedFile(entry);
      if (!contentResult.ok) {
        warnings.push(`Cannot read ${entry.relPath.toString()}: ${contentResult.error.message}`);
        continue;
      }
      const parsedResult = parseWithLanguageAdapter(entry.relPath, contentResult.value, config.limits);
      if (!parsedResult.ok) {
        warnings.push(parsedResult.error.message);
        continue;
      }
      parsed = parsedResult.value;
      parsedCount++;
    }
    nextParseCache.set(entry.relPath.toString(), { size: entry.size, mtimeMs: stat.mtimeMs, parsed });
    if (parsed.hasSyntaxErrors) {
      warnings.push(`File has syntax errors, parsed leniently: ${entry.relPath.toString()}`);
    }

    const fileNode = addFileNodes(graph, index, entry.relPath, parsed);
    index.fileNodes.set(entry.relPath, fileNode.id);
    index.parsedFiles.set(entry.relPath, parsed);

    // Symbol nodes + containment (same-file edges only, targets exist now)
    const symbolsByFile = new Map<string, NodeId[]>();
    const exportedByFile = new Map<string, NodeId[]>();
    for (const symbol of parsed.symbols) {
      const node = symbolNode(symbol, entry.relPath);
      graph.addNode(node);
      addEdge(graph, fileNode.id, node.id, "contains", { source: "ast", location: `${entry.relPath.toString()}:${symbol.startLine}` });
      pushSymbol(symbolsByFile, symbol.name, node.id);
      if (symbol.exported || symbol.isDefault) pushSymbol(exportedByFile, symbol.name, node.id);
    }
    index.symbolsByFile.set(entry.relPath, symbolsByFile);
    index.exportedByFile.set(entry.relPath, exportedByFile);
    pending.push({ entry, parsed });
  }

  // PASS 2: all cross-file and file-level edges
  for (const { entry, parsed } of pending) {
    const fileNodeId = index.fileNodes.get(entry.relPath);
    if (!fileNodeId) continue;
    const symbolsByFile = index.symbolsByFile.get(entry.relPath) ?? new Map<string, NodeId[]>();
    const exportedByFile = index.exportedByFile.get(entry.relPath) ?? new Map<string, NodeId[]>();

    const checked = (result: Result<import("../graph/graph.js").GraphPatch, import("../types/result.js").InvalidEdgeError>, what: string): void => {
      if (!result.ok) {
        warnings.push(`Dropped edge (${what}) for ${entry.relPath.toString()}: ${result.error.message}`);
      }
    };

    for (const [name, ids] of exportedByFile) {
      for (const id of ids) {
        checked(addEdge(graph, fileNodeId, id, "exports", { source: "ast", location: `${entry.relPath.toString()}:${name}` }), "exports");
      }
    }

    for (const imp of parsed.imports) {
      const target = resolveImport(graph, index, knownFiles, entry.relPath, imp.specifier);
      if (target) {
        const relation: Relation = graph.getNode(target)?.kind === "package" ? "depends_on" : "imports";
        checked(addEdge(graph, fileNodeId, target, relation, { source: "ast", location: entry.relPath.toString() }), relation);
      }
    }

    for (const re of parsed.reexports) {
      if (!re.specifier) continue;
      const target = resolveImport(graph, index, knownFiles, entry.relPath, re.specifier);
      if (target) {
        checked(addEdge(graph, fileNodeId, target, "reexports", { source: "ast" }), "reexports");
      }
    }

    if (isTestFile(entry.relPath)) {
      for (const imp of parsed.imports) {
        const target = resolveImport(graph, index, knownFiles, entry.relPath, imp.specifier);
        if (!target) continue;
        const targetNode = graph.getNode(target);
        if (targetNode?.kind === "file" && !targetNode.isTest) {
          checked(addEdge(graph, fileNodeId, target, "tests", { source: "ast" }), "tests");
        }
      }
    }

    for (const symbol of parsed.symbols) {
      const sourceIds = symbolsByFile.get(symbol.name);
      const sourceId = sourceIds?.[0];
      if (!sourceId) continue;
      addReferenceEdges(graph, index, entry.relPath, parsed, symbol, sourceId);
    }
  }

  // -- package-level dependency edges (monorepo) --------------------------------
  for (const [, pkgDir] of index.packageDirByName) {
    const pkgNodeId = index.packageNodeByDir.get(pkgDir);
    if (!pkgNodeId) continue;
    const deps = new Set<NodeId>();
    for (const [p] of index.fileNodes) {
      if (pkgDir.toString() !== "" && !p.toString().startsWith(pkgDir.toString() + "/")) continue;
      const parsed = index.parsedFiles.get(p);
      if (!parsed) continue;
      for (const imp of parsed.imports) {
        if (imp.specifier.startsWith(".")) continue;
        const target = resolveImport(graph, index, knownFiles, p, imp.specifier);
        if (target && target !== pkgNodeId) deps.add(target);
      }
    }
    for (const depId of deps) {
      addEdge(graph, pkgNodeId, depId, "depends_on", { source: "ast" });
    }
  }

  attachRepositoryArtifacts(graph, scan.value.files);

  if (options.incrementalCache) saveParseCache(root, nextParseCache);
  return ok({ graph, index, warnings, incremental: { parsed: parsedCount, reused: reusedCount } });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPackageJson(root: string, relPath: SafeRelativePath): { name?: string; workspaces?: string[] } | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, relPath.toString()), "utf8")) as Record<string, unknown>;
    const result: { name?: string; workspaces?: string[] } = {};
    if (typeof pkg["name"] === "string") result.name = pkg["name"];
    if (Array.isArray(pkg["workspaces"])) {
      const workspaces = (pkg["workspaces"] as unknown[]).filter((w): w is string => typeof w === "string");
      if (workspaces.length > 0) result.workspaces = workspaces;
    }
    return result;
  } catch {
    return undefined;
  }
}

function addConfigNode(graph: Graph, index: CodeGraphIndex, relPath: SafeRelativePath): void {
  const fileId = makeNodeId("file", relPath.toString());
  const existing = graph.getNode(fileId);
  const fileNode: FileNode = {
    kind: "file",
    id: fileId,
    name: basenameSafe(relPath),
    path: relPath,
    language: "typescript",
    isTest: false,
  };
  if (!existing) graph.addNode(fileNode);
  index.fileNodes.set(relPath, fileId);
  const node: ConfigurationNode = {
    kind: "configuration",
    id: makeNodeId("configuration", relPath.toString()),
    name: basenameSafe(relPath),
    path: relPath,
  };
  graph.addNode(node);
  const scopeId = makeNodeId("repository", "root");
  addEdge(graph, node.id, scopeId, "configures", { source: "ast" });
}

function addFileNodes(
  graph: Graph,
  index: CodeGraphIndex,
  relPath: SafeRelativePath,
  parsed: ParsedFile | undefined,
): GraphNode {
  const workspaceId = makeNodeId("workspace", "root");
  const segments = relPath.toString().split("/");

  let pkgDir: SafeRelativePath | undefined;
  let pkgNodeId: NodeId | undefined;
  for (const [dir, nodeId] of index.packageNodeByDir) {
    if (dir.toString() === "" || relPath.toString().startsWith(dir.toString() + "/")) {
      if (pkgDir === undefined || dir.toString().length > pkgDir.toString().length) {
        pkgDir = dir;
        pkgNodeId = nodeId;
      }
    }
  }

  let current = pkgNodeId ?? workspaceId;
  const startIdx = pkgDir !== undefined && pkgDir.toString() !== "" ? pkgDir.toString().split("/").length : 0;
  for (let i = startIdx; i < segments.length - 1; i++) {
    const dirPath = segments.slice(0, i + 1).join("/");
    const dirId = makeNodeId("directory", dirPath);
    let dirNode = graph.getNode(dirId);
    if (!dirNode) {
      dirNode = {
        kind: "directory",
        id: dirId,
        name: segments[i] ?? dirPath,
        path: dirPath as SafeRelativePath,
      } satisfies DirectoryNode;
      graph.addNode(dirNode);
    }
    addEdge(graph, current, dirId, "contains", { source: "ast" });
    current = dirId;
  }

  const fileId = makeNodeId("file", relPath.toString());
  const existing = graph.getNode(fileId);
  if (existing) return existing;
  const fileNode: FileNode = {
    kind: "file",
    id: fileId,
    name: basenameSafe(relPath),
    path: relPath,
    language: parsed?.language ?? "typescript",
    isTest: isTestFile(relPath),
  };
  graph.addNode(fileNode);
  addEdge(graph, current, fileId, "contains", { source: "ast" });

  const rel = relPath.toString();
  if (/\/api\/|app\/.*\/route\.ts$|pages\/api\//.test(rel) && parsed) {
    for (const symbol of parsed.symbols) {
      if (!symbol.exported) continue;
      const route: ApiRouteNode = {
        kind: "apiRoute",
        id: makeNodeId("apiRoute", rel, symbol.name),
        name: symbol.name,
        path: relPath,
        line: symbol.startLine,
      };
      graph.addNode(route);
      addEdge(graph, fileId, route.id, "contains", { source: "ast" });
    }
  }
  if (rel.endsWith("middleware.ts")) {
    const mw: MiddlewareNode = {
      kind: "middleware",
      id: makeNodeId("middleware", rel),
      name: "middleware",
      path: relPath,
    };
    graph.addNode(mw);
    addEdge(graph, fileId, mw.id, "contains", { source: "ast" });
  }
  if (isTestFile(relPath)) {
    const test: TestNode = {
      kind: "test",
      id: makeNodeId("test", rel),
      name: basenameSafe(relPath),
      path: relPath,
    };
    graph.addNode(test);
    addEdge(graph, fileId, test.id, "contains", { source: "ast" });
  }
  return fileNode;
}

function symbolNode(symbol: ParsedSymbol, relPath: SafeRelativePath): GraphNode {
  const base = { name: symbol.name, path: relPath, line: symbol.startLine };
  const id = makeNodeId(symbolKind(symbol.kind), relPath.toString(), symbol.name);
  switch (symbol.kind) {
    case "function":
      return { kind: "function", id, ...base, exported: symbol.exported };
    case "method":
      return { kind: "method", id, ...base, className: symbol.name.split(".")[0] ?? "", exported: symbol.exported };
    case "class":
      return { kind: "class", id, ...base, exported: symbol.exported };
    case "interface":
      return { kind: "interface", id, ...base, exported: symbol.exported };
    case "typeAlias":
      return { kind: "typeAlias", id, ...base, exported: symbol.exported };
    case "enum":
      return { kind: "enum", id, ...base, exported: symbol.exported };
    case "variable":
      return { kind: "variable", id, ...base, exported: symbol.exported };
    case "reactComponent":
      return { kind: "reactComponent", id, ...base, exported: symbol.exported };
    case "reactHook":
      return { kind: "reactHook", id, ...base, exported: symbol.exported };
  }
}

function symbolKind(kind: ParsedSymbol["kind"]): string {
  switch (kind) {
    case "function":
      return "function";
    case "method":
      return "method";
    case "class":
      return "class";
    case "interface":
      return "interface";
    case "typeAlias":
      return "typeAlias";
    case "enum":
      return "enum";
    case "variable":
      return "variable";
    case "reactComponent":
      return "reactComponent";
    case "reactHook":
      return "reactHook";
  }
}

/**
 * Resolve an import specifier to a target node id (file node or package
 * node). External packages get an `external: true` package node so
 * dependency edges are still explainable.
 */
function resolveImport(
  graph: Graph,
  index: CodeGraphIndex,
  knownFiles: Set<SafeRelativePath>,
  importerPath: SafeRelativePath,
  specifier: string,
): NodeId | undefined {
  if (specifier.startsWith(".")) {
    const resolved = resolveRelativeFile(knownFiles, importerPath, specifier);
    if (!resolved) return undefined;
    const existing = index.fileNodes.get(resolved);
    if (existing) return existing;
    return makeNodeId("file", resolved.toString());
  }
  const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0] ?? specifier;
  const pkgDir = index.packageDirByName.get(packageName);
  if (pkgDir !== undefined) {
    const pkgNodeId = index.packageNodeByDir.get(pkgDir);
    return pkgNodeId;
  }
  const externalId = makeNodeId("package", "external", packageName);
  if (!graph.getNode(externalId)) {
    graph.addNode({
      kind: "package",
      id: externalId,
      name: packageName,
      external: true,
    } satisfies PackageNode);
  }
  return externalId;
}

function resolveRelativeFile(
  knownFiles: Set<SafeRelativePath>,
  importerPath: SafeRelativePath,
  specifier: string,
): SafeRelativePath | undefined {
  const importerDir = dirnameSafe(importerPath);
  const cleaned = specifier.replace(/^\.\//, "");
  const raw = importerDir.toString() === "" ? cleaned : `${importerDir.toString()}/${cleaned}`;
  // Normalize `..` and `.` segments (e.g. src/a/../b -> src/b) BEFORE
  // validating: SafeRelativePath rejects traversal, but import specifiers
  // legitimately contain `..` to reach a parent directory.
  const normalized = path.posix.normalize(raw);
  if (normalized.startsWith("../") || normalized === "..") return undefined;
  const base = normalized === "." ? "" : normalized;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.py`,
    `${base}.go`,
    `${base}.java`,
    `${base}.rs`,
    `${base}.cs`,
    `${base}.php`,
    `${base}.rb`,
    `${base}.kt`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/__init__.py`,
  ];
  for (const candidate of candidates) {
    const safe = safeRelativePath(candidate);
    if (!safe.ok) continue;
    if (knownFiles.has(safe.value)) return safe.value;
  }
  return undefined;
}

function addReferenceEdges(
  graph: Graph,
  index: CodeGraphIndex,
  file: SafeRelativePath,
  parsed: ParsedFile,
  symbol: ParsedSymbol,
  sourceId: NodeId,
): void {
  const edgeFor = (refName: string, relation: Relation): void => {
    const target = resolveReferenceTarget(index, file, parsed, refName);
    if (target === undefined) return;
    addEdge(graph, sourceId, target, relation, {
      source: "ast",
      location: `${file.toString()}:${symbol.startLine}`,
    });
  };

  for (const ref of symbol.references) {
    const relation = referenceRelation(graph, index, file, parsed, ref);
    if (relation) edgeFor(ref, relation);
  }
  for (const jsxRef of symbol.jsxRefs) {
    edgeFor(jsxRef, "renders");
  }
  for (const h of symbol.heritage) {
    edgeFor(h.name, h.relation);
  }
}

function referenceRelation(
  graph: Graph,
  index: CodeGraphIndex,
  file: SafeRelativePath,
  parsed: ParsedFile,
  ref: string,
): Relation | undefined {
  const target = resolveReferenceTarget(index, file, parsed, ref);
  if (target === undefined) return undefined;
  const node = graph.getNode(target);
  if (!node) return undefined;
  switch (node.kind) {
    case "function":
    case "method":
    case "reactComponent":
    case "reactHook":
      return "calls";
    case "class":
    case "variable":
      return "uses";
    case "interface":
    case "typeAlias":
    case "enum":
      return "references";
    default:
      return "uses";
  }
}

function resolveReferenceTarget(
  index: CodeGraphIndex,
  file: SafeRelativePath,
  parsed: ParsedFile,
  ref: string,
): NodeId | undefined {
  // 1. local symbols
  const local = index.symbolsByFile.get(file)?.get(ref);
  if (local && local.length > 0) return local[0];

  // 2. imported bindings
  for (const imp of parsed.imports) {
    for (const binding of imp.bindings) {
      if (binding.local !== ref) continue;
      const exportedName = binding.imported ?? ref;
      const target = findExportedSymbol(index, file, imp.specifier, exportedName);
      if (target) return target;
      return undefined;
    }
    // default import: `import foo from "./x"` where x has `export default foo`
    if (imp.defaultName !== undefined && imp.defaultName === ref) {
      const target = findDefaultSymbol(index, file, imp.specifier, ref);
      if (target) return target;
      return undefined;
    }
  }
  return undefined;
}

/** Files an import specifier can resolve to (relative or workspace package). */
function resolveImportFiles(index: CodeGraphIndex, file: SafeRelativePath, specifier: string): SafeRelativePath[] {
  if (specifier.startsWith(".")) {
    const known = new Set(index.fileNodes.keys());
    const resolved = resolveRelativeFile(known, file, specifier);
    return resolved ? [resolved] : [];
  }
  const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0] ?? specifier;
  const pkgDir = index.packageDirByName.get(packageName);
  if (pkgDir === undefined) return [];
  const files: SafeRelativePath[] = [];
  for (const p of index.fileNodes.keys()) {
    if (pkgDir.toString() === "" || p.toString().startsWith(pkgDir.toString() + "/")) {
      files.push(p);
    }
  }
  return files;
}

function findExportedSymbol(
  index: CodeGraphIndex,
  file: SafeRelativePath,
  specifier: string,
  exportedName: string,
): NodeId | undefined {
  for (const targetFile of resolveImportFiles(index, file, specifier)) {
    const match = index.exportedByFile.get(targetFile)?.get(exportedName);
    if (match && match.length > 0) return match[0];
    const any = index.symbolsByFile.get(targetFile)?.get(exportedName);
    if (any && any.length > 0) return any[0];
  }
  return undefined;
}

function findDefaultSymbol(
  index: CodeGraphIndex,
  file: SafeRelativePath,
  specifier: string,
  ref: string,
): NodeId | undefined {
  for (const targetFile of resolveImportFiles(index, file, specifier)) {
    const defaultSymbol = index.parsedFiles.get(targetFile)?.symbols.find((s) => s.isDefault);
    const name = defaultSymbol?.name;
    if (name) {
      const match = index.exportedByFile.get(targetFile)?.get(name);
      if (match && match.length > 0) return match[0];
    }
    const match = index.exportedByFile.get(targetFile)?.get(ref);
    if (match && match.length > 0) return match[0];
  }
  return undefined;
}

function pushSymbol(map: Map<string, NodeId[]>, name: string, id: NodeId): void {
  const list = map.get(name);
  if (list) list.push(id);
  else map.set(name, [id]);
}

/**
 * Add an edge and report the outcome. Fixed-relation helper edges (e.g.
 * `contains`) are added with `void addEdge(...)`; dynamic edges added in
 * the two-phase pass are checked by the caller and failures surface as
 * build warnings so graph-correctness bugs are never silent.
 */
function addEdge(
  graph: Graph,
  from: NodeId,
  to: NodeId,
  relation: Relation,
  provenance: EdgeProvenance,
): Result<import("../graph/graph.js").GraphPatch, import("../types/result.js").InvalidEdgeError> {
  return graph.addEdge({ id: makeEdgeId(from, relation, to), from, to, relation, provenance });
}

export type { GraphEdge };
