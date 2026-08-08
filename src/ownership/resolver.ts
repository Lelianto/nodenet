/**
 * Ownership resolution (NodeNet spec §10).
 *
 * Sources are ranked: LCDD explicit authority > NodeNet explicit ownership
 * > CODEOWNERS > Git history. Git history can only ever produce a "likely
 * reviewer" suggestion, never a required reviewer (spec §10, §57).
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import { matchGlob } from "../utils/glob.js";
import type { SafeRelativePath } from "../security/filesystem.js";
import type { OwnershipRecord, OwnershipSource, OwnershipConfidence } from "./schema.js";
import { SOURCE_PRIORITY, CONFIDENCE_RANK } from "./schema.js";
import type { ContextRecord } from "../context/schema.js";
import { isActiveContext } from "../context/lcdd.js";
import type { LoadedConfig } from "../config/config.js";

export interface OwnershipResolution {
  owner: string;
  source: OwnershipSource;
  confidence: OwnershipConfidence;
}

export interface OwnershipIndex {
  records: OwnershipRecord[];
  /** Resolve ownership for a path, or null. */
  resolveOwner(relPath: SafeRelativePath): OwnershipResolution | null;
  /** All records matching a path. */
  matching(relPath: SafeRelativePath): OwnershipRecord[];
}

/** Build an ownership index from context + config + CODEOWNERS + git. */
export function buildOwnershipIndex(
  contexts: ContextRecord[],
  config: LoadedConfig,
  root: string,
): OwnershipIndex {
  const records: OwnershipRecord[] = [];

  // 1. LCDD context metadata: context owner + appliesTo glob.
  for (const ctx of contexts) {
    if (!isActiveContext(ctx)) continue;
    if (!ctx.owner) continue;
    for (const pattern of ctx.appliesTo) {
      records.push({
        pattern,
        owner: ctx.owner,
        source: "lcdd",
        confidence: ctx.provenance.kind === "FACT" || ctx.provenance.kind === "USER_DECLARED" ? "AUTHORITATIVE" : "DECLARED",
      });
    }
  }

  // 2. NodeNet explicit ownership (config overrides).
  for (const o of config.ownership.overrides) {
    records.push({
      pattern: o.pattern,
      owner: o.owner,
      source: (o.source as OwnershipSource) ?? "nodenet",
      confidence: (o.confidence as OwnershipConfidence) ?? "DECLARED",
    });
  }

  // 3. .nodenet/ownership.json (explicit NodeNet ownership records).
  const ownershipFile = path.join(root, ".nodenet", "ownership.json");
  if (fs.existsSync(ownershipFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ownershipFile, "utf8")) as unknown;
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (typeof entry !== "object" || entry === null) continue;
          const e = entry as Record<string, unknown>;
          if (typeof e.pattern === "string" && typeof e.owner === "string") {
            records.push({
              pattern: e.pattern,
              owner: e.owner,
              source: (e.source as OwnershipSource) ?? "nodenet",
              confidence: (e.confidence as OwnershipConfidence) ?? "DECLARED",
            });
          }
        }
      }
    } catch (e) {
      void e; // malformed ownership.json is ignored (analyzer reports a warning)
    }
  }

  // 4. CODEOWNERS.
  const codeowners = readCodeowners(root);
  for (const [pattern, owners] of codeowners) {
    for (const owner of owners) {
      records.push({ pattern, owner, source: "codeowners", confidence: "AUTHORITATIVE" });
    }
  }

  return {
    records,
    resolveOwner(relPath) {
      let best: OwnershipRecord | null = null;
      for (const record of records) {
        if (!matchGlob(record.pattern, relPath.toString())) continue;
        if (best === null) {
          best = record;
          continue;
        }
        // Source priority wins (lower number = higher priority); ties are
        // broken by higher confidence (spec §10, §11).
        const bySource = SOURCE_PRIORITY[record.source] - SOURCE_PRIORITY[best.source];
        if (bySource < 0) {
          best = record;
        } else if (bySource === 0) {
          if (CONFIDENCE_RANK[record.confidence] > CONFIDENCE_RANK[best.confidence]) best = record;
        }
      }
      if (!best) return null;
      return { owner: best.owner, source: best.source, confidence: best.confidence };
    },
    matching(relPath) {
      return records.filter((r) => matchGlob(r.pattern, relPath.toString()));
    },
  };
}

/** Parse a CODEOWNERS file into (pattern, owners) entries. */
export function readCodeowners(root: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const candidate of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    const file = path.join(root, candidate);
    if (!fs.existsSync(file)) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch (e) {
      void e;
      continue;
    }
    for (const rawLine of content.split("\n")) {
      const line = rawLine.split("#")[0]?.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      const pattern = parts[0];
      if (!pattern) continue;
      const owners = parts.slice(1).filter((p) => p.startsWith("@") || /^[a-zA-Z0-9-]+$/.test(p));
      if (owners.length > 0) result.set(pattern, owners);
    }
    break; // first CODEOWNERS found wins
  }
  return result;
}

/** Parse a CODEOWNERS file for display. */
export function readCodeownersRaw(root: string): Result<Map<string, string[]>, Error> {
  try {
    return ok(readCodeowners(root));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Suggest a likely reviewer from Git history (inferred only — never a
 * required reviewer, spec §57). Uses argument arrays, never shell string
 * concatenation (spec §42).
 */
export function gitHistorySuggestion(
  root: string,
  relPath: SafeRelativePath,
): Result<string | null, Error> {
  const result = spawnSync(
    "git",
    ["-C", root, "log", "--follow", "--format=%an", "--", relPath.toString()],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.error) return ok(null); // no git or not a repo: no suggestion
  const authors = (result.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (authors.length === 0) return ok(null);
  const counts = new Map<string, number>();
  for (const a of authors) counts.set(a, (counts.get(a) ?? 0) + 1);
  let best: string | null = authors[0] ?? null;
  let bestCount = 0;
  for (const [author, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = author;
    }
  }
  return ok(best);
}
