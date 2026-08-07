/**
 * Change impact analysis (NodeNet spec §12–§15).
 *
 * Maps a git diff to symbol-level changes, traverses the graph to find
 * affected code, context, ownership and authority, and detects ownership
 * boundary crossings. This is the core value of NodeNet: knowing what a
 * change affects and who should review it.
 */

import type { Result } from "../types/result.js";
import { ok } from "../types/result.js";
import type { NodeId } from "../types/brand.js";
import type { SafeRelativePath } from "../security/filesystem.js";
import type { Graph } from "../graph/graph.js";
import { collectAffected } from "../graph/traversal.js";
import type { CodeGraphIndex } from "../analyzer/code-graph.js";
import type { ContextRecord } from "../context/schema.js";
import type { OwnershipIndex } from "../ownership/resolver.js";
import type { LoadedConfig } from "../config/config.js";
import { isSuppressed } from "../storage/storage.js";
import { matchGlob } from "../utils/glob.js";
import { gitDiffChanges, type ChangedHunk } from "./diff.js";
import { computeSeverity, type Severity } from "../review/severity.js";

export interface SymbolChange {
  relPath: SafeRelativePath;
  symbolName: string;
  changeKind: "added" | "removed" | "modified";
  nodeId?: NodeId;
  startLine: number;
  endLine: number;
}

export interface ImpactOptions {
  base?: string;
  /** Explicit changes (skips git) — used by tests and programmatic API. */
  changes?: ChangedHunk[];
  /** Team of the change author, for boundary detection. */
  developerTeam?: string;
  maxDepth?: number;
  maxNodes?: number;
  now?: Date;
}

export interface BoundaryCrossing {
  fromTeam: string;
  toTeam: string;
  viaFile: string;
}

export interface AffectedOwner {
  file: string;
  owner: string;
  source: string;
  confidence: string;
}

export interface ImpactReport {
  severity: Severity;
  severityReasons: string[];
  crossTeamBoundary: boolean;
  changedFiles: SafeRelativePath[];
  changedSymbols: SymbolChange[];
  affectedFiles: SafeRelativePath[];
  affectedNodeIds: NodeId[];
  affectedContexts: ContextRecord[];
  boundaries: BoundaryCrossing[];
  owners: AffectedOwner[];
  reasons: string[];
}

export function analyzeImpact(
  root: string,
  config: LoadedConfig,
  graph: Graph,
  index: CodeGraphIndex,
  ownershipIndex: OwnershipIndex,
  contexts: ContextRecord[],
  opts: ImpactOptions = {},
): Result<ImpactReport, Error> {
  const reasons: string[] = [];
  const now = opts.now ?? new Date();

  // 1. Change set -------------------------------------------------------------
  let changes: ChangedHunk[];
  if (opts.changes) {
    changes = opts.changes;
  } else {
    const diff = gitDiffChanges(root, opts.base);
    if (!diff.ok) return diff;
    changes = diff.value;
  }
  const suppressions = config.suppressions;
  changes = changes.filter((h) => !isSuppressed(suppressions, h.relPath.toString(), now));

  // 2. Symbol-level changes ----------------------------------------------------
  const changedSymbols: SymbolChange[] = [];
  const changedFiles = new Set<SafeRelativePath>();
  for (const hunk of changes) {
    changedFiles.add(hunk.relPath);
    const parsed = index.parsedFiles.get(hunk.relPath);
    if (!parsed) {
      changedSymbols.push({
        relPath: hunk.relPath,
        symbolName: "(file-level)",
        changeKind: hunk.isDeletedFile ? "removed" : hunk.isNewFile ? "added" : "modified",
        startLine: 1,
        endLine: 1,
      });
      continue;
    }
    let matched = false;
    for (const symbol of parsed.symbols) {
      if (hunk.isDeletedFile) {
        changedSymbols.push({ relPath: hunk.relPath, symbolName: symbol.name, changeKind: "removed", startLine: symbol.startLine, endLine: symbol.endLine });
        matched = true;
        continue;
      }
      if (hunk.isNewFile) {
        changedSymbols.push({ relPath: hunk.relPath, symbolName: symbol.name, changeKind: "added", startLine: symbol.startLine, endLine: symbol.endLine });
        matched = true;
        continue;
      }
      const overlaps = hunk.addedLines.some(
        (line) => line >= symbol.startLine && line <= symbol.endLine,
      );
      if (overlaps) {
        changedSymbols.push({ relPath: hunk.relPath, symbolName: symbol.name, changeKind: "modified", startLine: symbol.startLine, endLine: symbol.endLine });
        matched = true;
      }
    }
    if (!matched && hunk.addedLines.length > 0) {
      changedSymbols.push({
        relPath: hunk.relPath,
        symbolName: "(file-level)",
        changeKind: "modified",
        startLine: hunk.addedLines[0] ?? 1,
        endLine: hunk.addedLines[hunk.addedLines.length - 1] ?? 1,
      });
    }
  }

  // resolve node ids for changed symbols
  for (const change of changedSymbols) {
    if (change.symbolName.startsWith("(")) continue;
    const ids = index.symbolsByFile.get(change.relPath)?.get(change.symbolName);
    const id = ids?.[0];
    if (id) change.nodeId = id;
  }

  // 3. Seed + traversal ---------------------------------------------------------
  const seeds = new Set<NodeId>();
  for (const change of changedSymbols) {
    if (change.nodeId) seeds.add(change.nodeId);
  }
  for (const file of changedFiles) {
    const fileNodeId = index.fileNodes.get(file);
    if (fileNodeId) seeds.add(fileNodeId);
  }

  const affectedSet = collectAffected(
    graph,
    [...seeds],
    {
      maxDepth: opts.maxDepth ?? config.limits.maxTraversalDepth,
      maxNodes: opts.maxNodes ?? config.limits.maxTraversalNodes,
    },
    (edge) => edge.relation !== "contains",
  );
  const affectedNodeIds = [...affectedSet];

  const affectedFiles = new Set<SafeRelativePath>();
  for (const id of affectedSet) {
    const node = graph.getNode(id);
    if (node?.kind === "file") {
      affectedFiles.add((node as { path: SafeRelativePath }).path);
    }
  }

  // 4. Contexts ----------------------------------------------------------------
  const affectedContexts: ContextRecord[] = [];
  const seenContexts = new Set<string>();
  for (const ctx of contexts) {
    if (seenContexts.has(ctx.id)) continue;
    const applies = ctx.appliesTo.some((pattern) =>
      [...affectedFiles, ...changedFiles].some((f) => matchGlob(pattern, f.toString())),
    );
    if (applies) {
      affectedContexts.push(ctx);
      seenContexts.add(ctx.id);
    }
  }

  // 5. Ownership + boundaries -----------------------------------------------------
  const owners: AffectedOwner[] = [];
  const boundaries: BoundaryCrossing[] = [];
  const developerTeam = opts.developerTeam ?? config.developer.team;
  for (const file of [...changedFiles, ...affectedFiles]) {
    const resolution = ownershipIndex.resolveOwner(file);
    if (!resolution) continue;
    owners.push({ file: file.toString(), owner: resolution.owner, source: resolution.source, confidence: resolution.confidence });
    if (developerTeam && resolution.owner !== developerTeam) {
      boundaries.push({ fromTeam: developerTeam, toTeam: resolution.owner, viaFile: file.toString() });
    }
  }
  const crossTeamBoundary = boundaries.length > 0;

  // 6. Severity ------------------------------------------------------------------
  const severityResult = computeSeverity({
    changedFiles: [...changedFiles].map((f) => f.toString()),
    affectedContexts,
    crossTeamBoundary,
  });
  reasons.push(...severityResult.reasons);

  return ok({
    severity: severityResult.severity,
    severityReasons: severityResult.reasons,
    crossTeamBoundary,
    changedFiles: [...changedFiles],
    changedSymbols,
    affectedFiles: [...affectedFiles],
    affectedNodeIds,
    affectedContexts,
    boundaries,
    owners,
    reasons,
  });
}
