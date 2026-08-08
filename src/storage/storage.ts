/**
 * Graph storage (NodeNet spec §52, §34).
 *
 * Local-first: `.nodenet/graph.json`, `index.json` (fingerprints),
 * `metadata.json`, `audit.jsonl`, `suppressions.json`. No external
 * database is required. All persisted data is runtime-validated on load —
 * TypeScript types are never trusted on their own.
 */

import fs from "node:fs";
import path from "node:path";
import type { Result } from "../types/result.js";
import { ok, err, errorMessage, GraphBuildError } from "../types/result.js";
import { Graph, type GraphSnapshot } from "../graph/graph.js";
import { ALL_NODE_KINDS, type GraphNode } from "../graph/nodes.js";
import { ALL_RELATIONS, EVIDENCE_CLASSES, evidenceClassForSource, type GraphEdge, type EdgeProvenance } from "../graph/edges.js";
import type { Suppression } from "../config/config.js";
import { matchGlob } from "../utils/glob.js";

export const DOT_NODENET = ".nodenet";

export function dotNodenetDir(root: string): string {
  return path.join(root, DOT_NODENET);
}

export function ensureDotNodenet(root: string): void {
  fs.mkdirSync(dotNodenetDir(root), { recursive: true });
}

// ---------------------------------------------------------------------------
// Graph persistence
// ---------------------------------------------------------------------------

export function saveGraph(root: string, graph: Graph): Result<void, Error> {
  try {
    ensureDotNodenet(root);
    const snapshot = graph.toSnapshot();
    fs.writeFileSync(path.join(dotNodenetDir(root), "graph.json"), JSON.stringify(snapshot, null, 2));
    fs.writeFileSync(
      path.join(dotNodenetDir(root), "metadata.json"),
      JSON.stringify(snapshot.metadata, null, 2),
    );
    return ok(undefined);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Load and runtime-validate a persisted graph. Returns null when absent. */
export function loadGraph(root: string, limits?: { maxNodes: number; maxEdges: number }): Result<Graph | null, Error> {
  const file = path.join(dotNodenetDir(root), "graph.json");
  if (!fs.existsSync(file)) return ok(null);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return err(new GraphBuildError(`Cannot parse ${file}: ${errorMessage(e)}`));
  }
  const validation = validateSnapshot(raw);
  if (!validation.ok) return validation;
  const fromSnapshot = Graph.fromSnapshot(validation.value, limits);
  if (!fromSnapshot.ok) {
    const detail = Array.isArray(fromSnapshot.error)
      ? fromSnapshot.error.map((e) => e.message).slice(0, 5).join("; ")
      : fromSnapshot.error.message;
    return err(new GraphBuildError(`Stored graph failed validation: ${detail}`));
  }
  return ok(fromSnapshot.value);
}

/**
 * Structural runtime validation of a stored snapshot. Edge pair legality is
 * re-checked by Graph.fromSnapshot.
 */
function validateSnapshot(raw: unknown): Result<GraphSnapshot, Error> {
  if (typeof raw !== "object" || raw === null) {
    return err(new GraphBuildError("Stored graph is not an object."));
  }
  const snapshot = raw as Record<string, unknown>;
  if (!Array.isArray(snapshot["nodes"]) || !Array.isArray(snapshot["edges"])) {
    return err(new GraphBuildError("Stored graph must contain nodes[] and edges[]."));
  }
  const nodes: GraphNode[] = [];
  for (const n of snapshot["nodes"]) {
    const parsed = validateNode(n);
    if (!parsed) {
      return err(new GraphBuildError("Stored graph contains an invalid node."));
    }
    nodes.push(parsed);
  }
  const edges: GraphEdge[] = [];
  for (const e of snapshot["edges"]) {
    const parsed = validateEdge(e);
    if (!parsed) {
      return err(new GraphBuildError("Stored graph contains an invalid edge."));
    }
    edges.push(parsed);
  }
  const meta = (snapshot["metadata"] ?? {}) as Record<string, unknown>;
  return ok({
    metadata: {
      version: 1,
      builtAt: typeof meta["builtAt"] === "string" ? meta["builtAt"] : new Date().toISOString(),
      root: typeof meta["root"] === "string" ? meta["root"] : ".",
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
    nodes,
    edges,
  });
}

function validateNode(raw: unknown): GraphNode | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const n = raw as Record<string, unknown>;
  const kind = n["kind"];
  if (typeof kind !== "string" || !(ALL_NODE_KINDS as readonly string[]).includes(kind)) return undefined;
  if (typeof n["id"] !== "string" || typeof n["name"] !== "string") return undefined;
  const base = { id: n["id"] as GraphNode["id"], name: n["name"] as string };
  switch (kind) {
    case "file": {
      if (typeof n["path"] !== "string") return undefined;
      return { ...base, kind, path: n["path"], language: (n["language"] as GraphNode & { language: string })?.language ?? "typescript", isTest: n["isTest"] === true } as GraphNode;
    }
    case "directory":
      return { ...base, kind, path: (n["path"] as string) ?? "" } as GraphNode;
    case "repository":
      return { ...base, kind, root: (n["root"] as string) ?? "" } as GraphNode;
    case "workspace":
      return { ...base, kind } as GraphNode;
    case "package":
      return { ...base, kind, external: n["external"] === true, ...(typeof n["path"] === "string" ? { path: n["path"] } : {}) } as GraphNode;
    case "function":
    case "class":
    case "interface":
    case "typeAlias":
    case "enum":
    case "variable":
    case "reactComponent":
    case "reactHook":
      return { ...base, kind, path: (n["path"] as string) ?? "", line: (n["line"] as number) ?? 0, exported: n["exported"] === true } as GraphNode;
    case "method":
      return { ...base, kind, path: (n["path"] as string) ?? "", line: (n["line"] as number) ?? 0, className: (n["className"] as string) ?? "", exported: n["exported"] === true } as GraphNode;
    case "apiRoute":
      return { ...base, kind, path: (n["path"] as string) ?? "", line: (n["line"] as number) ?? 0 } as GraphNode;
    case "middleware":
    case "test":
      return { ...base, kind, path: (n["path"] as string) ?? "" } as GraphNode;
    case "configuration":
      return { ...base, kind, path: (n["path"] as string) ?? "" } as GraphNode;
    case "document":
    case "apiOperation":
    case "databaseTable":
    case "infrastructureResource":
      return { ...base, kind, path: (n["path"] as string) ?? "", ...(typeof n["line"] === "number" ? { line: n["line"] } : {}), artifactType: (n["artifactType"] as "adr" | "openapi" | "sql" | "terraform") ?? "adr" } as GraphNode;
    case "businessRule":
    case "architectureDecision":
    case "securityPolicy":
    case "codingConvention":
    case "requirement":
    case "specification":
    case "complianceRule":
    case "operationalRule":
    case "incidentLearning":
    case "assumption":
    case "domainRule":
    case "externalConstraint":
      return {
        ...base,
        kind,
        contextId: (n["contextId"] as string) ?? "",
        status: (n["status"] as string) ?? "ACTIVE",
        authority: (n["authority"] as string) ?? "GUIDELINE",
        type: (n["type"] as string) ?? "assumption",
        ...(typeof n["governanceClassification"] === "string" ? { governanceClassification: n["governanceClassification"] } : {}),
        ...(typeof n["approvalRequired"] === "boolean" ? { approvalRequired: n["approvalRequired"] } : {}),
        ...(typeof n["enforcementMode"] === "string" ? { enforcementMode: n["enforcementMode"] } : {}),
        ...(typeof n["sourceFormat"] === "string" ? { sourceFormat: n["sourceFormat"] } : {}),
      } as GraphNode;
    case "team":
      return { ...base, kind, teamId: (n["teamId"] as string) ?? "" } as GraphNode;
    case "developer":
      return { ...base, kind, handle: (n["handle"] as string) ?? "" } as GraphNode;
    case "role":
      return { ...base, kind } as GraphNode;
    default:
      return undefined;
  }
}

function validateEdge(raw: unknown): GraphEdge | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  if (
    typeof e["id"] !== "string" ||
    typeof e["from"] !== "string" ||
    typeof e["to"] !== "string" ||
    typeof e["relation"] !== "string" ||
    !(ALL_RELATIONS as readonly string[]).includes(e["relation"])
  ) {
    return undefined;
  }
  const provenanceRaw = (e["provenance"] ?? {}) as Record<string, unknown>;
  const source = (provenanceRaw["source"] as EdgeProvenance["source"]) ?? "ast";
  const classification = typeof provenanceRaw["classification"] === "string" &&
    (EVIDENCE_CLASSES as readonly string[]).includes(provenanceRaw["classification"])
    ? provenanceRaw["classification"] as NonNullable<EdgeProvenance["classification"]>
    : evidenceClassForSource(source);
  const provenance: EdgeProvenance = {
    source,
    classification,
    ...(typeof provenanceRaw["location"] === "string" ? { location: provenanceRaw["location"] } : {}),
    ...(typeof provenanceRaw["rationale"] === "string" ? { rationale: provenanceRaw["rationale"] } : {}),
  };
  return {
    id: e["id"] as GraphEdge["id"],
    from: e["from"] as GraphEdge["from"],
    to: e["to"] as GraphEdge["to"],
    relation: e["relation"] as GraphEdge["relation"],
    provenance,
  };
}

// ---------------------------------------------------------------------------
// Symbol cache (true line ranges for symbol-level diffing after a reload)
// ---------------------------------------------------------------------------

export interface CachedSymbol {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  isDefault: boolean;
}

/**
 * Persist per-file symbol line info. The graph stores only declaration
 * lines; the symbol cache preserves full [startLine, endLine] ranges so
 * `impact` can still do symbol-level change detection after a reload.
 */
export function saveSymbolCache(root: string, symbols: Map<string, CachedSymbol[]>): void {
  try {
    ensureDotNodenet(root);
    const obj: Record<string, unknown> = {};
    for (const [file, list] of symbols) obj[file] = list;
    fs.writeFileSync(path.join(dotNodenetDir(root), "symbols.json"), JSON.stringify(obj));
  } catch {
    // cache persistence failures are non-fatal
  }
}

export function loadSymbolCache(root: string): Map<string, CachedSymbol[]> {
  const result = new Map<string, CachedSymbol[]>();
  const file = path.join(dotNodenetDir(root), "symbols.json");
  if (!fs.existsSync(file)) return result;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return result;
    for (const [filePath, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const symbols: CachedSymbol[] = [];
      for (const entry of value) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (
          typeof e["kind"] === "string" &&
          typeof e["name"] === "string" &&
          typeof e["startLine"] === "number" &&
          typeof e["endLine"] === "number"
        ) {
          symbols.push({
            kind: e["kind"],
            name: e["name"],
            startLine: e["startLine"],
            endLine: e["endLine"],
            exported: e["exported"] === true,
            isDefault: e["isDefault"] === true,
          });
        }
      }
      result.set(filePath, symbols);
    }
  } catch {
    // corrupt cache => fall back to node-derived line info
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fingerprints (incremental update support, spec §51)
// ---------------------------------------------------------------------------

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

export function loadFingerprints(root: string): Map<string, FileFingerprint> {
  const file = path.join(dotNodenetDir(root), "index.json");
  const result = new Map<string, FileFingerprint>();
  if (!fs.existsSync(file)) return result;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "object" && value !== null) {
          const v = value as Record<string, unknown>;
          result.set(key, { size: (v["size"] as number) ?? 0, mtimeMs: (v["mtimeMs"] as number) ?? 0 });
        }
      }
    }
  } catch {
    // corrupt index.json => treat as empty (full rebuild)
  }
  return result;
}

export function saveFingerprints(root: string, fingerprints: Map<string, FileFingerprint>): void {
  try {
    ensureDotNodenet(root);
    const obj: Record<string, FileFingerprint> = {};
    for (const [key, value] of fingerprints) obj[key] = value;
    fs.writeFileSync(path.join(dotNodenetDir(root), "index.json"), JSON.stringify(obj, null, 2));
  } catch {
    // fingerprint persistence failures are non-fatal
  }
}

// ---------------------------------------------------------------------------
// Audit log (spec §48) — append-only, never logs secrets or source contents
// ---------------------------------------------------------------------------

export interface AuditEntry {
  type: string;
  at: string;
  [key: string]: string | number | boolean;
}

export function appendAudit(root: string, entry: AuditEntry): void {
  try {
    ensureDotNodenet(root);
    fs.appendFileSync(
      path.join(dotNodenetDir(root), "audit.jsonl"),
      JSON.stringify({ ...entry, at: entry.at ?? new Date().toISOString() }) + "\n",
    );
  } catch {
    // audit failures are non-fatal
  }
}

// ---------------------------------------------------------------------------
// Suppressions (spec §60)
// ---------------------------------------------------------------------------

export function loadSuppressions(root: string): Suppression[] {
  const file = path.join(dotNodenetDir(root), "suppressions.json");
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (Array.isArray(raw)) {
      return raw.filter((s): s is Suppression => {
        if (typeof s !== "object" || s === null) return false;
        const e = s as Record<string, unknown>;
        return (
          typeof e["pattern"] === "string" &&
          typeof e["reason"] === "string" &&
          typeof e["owner"] === "string" &&
          typeof e["createdAt"] === "string"
        );
      });
    }
    return [];
  } catch {
    return [];
  }
}

export function isSuppressed(suppressions: Suppression[], path: string, now: Date): boolean {
  for (const s of suppressions) {
    if (s.expiresAt !== undefined && new Date(s.expiresAt).getTime() < now.getTime()) continue;
    if (matchGlob(s.pattern, path)) return true;
  }
  return false;
}
