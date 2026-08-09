/** Bounded, versioned local cache for secret-free Minimum Sufficient Context bundles. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ContextBundle, ContextBundleOptions } from "./context-builder.js";

interface CacheFile { version: 1; entries: Record<string, { createdAt: string; bundle: ContextBundle }> }

const MAX_ENTRIES = 100;

export function contextCacheKey(input: {
  graphBuiltAt: string;
  target: string;
  options: ContextBundleOptions;
  contextFingerprint: string;
}): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function readContextCache(root: string, key: string): ContextBundle | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(root), "utf8")) as CacheFile;
    return parsed.version === 1 ? parsed.entries[key]?.bundle : undefined;
  } catch {
    return undefined;
  }
}

export function writeContextCache(root: string, key: string, bundle: ContextBundle): void {
  if (bundle.secretFlagged || bundle.sourceEvidence.length > 0) return;
  const file = cacheFile(root);
  let cache: CacheFile = { version: 1, entries: {} };
  try { cache = JSON.parse(fs.readFileSync(file, "utf8")) as CacheFile; } catch { /* first write */ }
  cache.entries[key] = { createdAt: new Date().toISOString(), bundle };
  const ordered = Object.entries(cache.entries).sort((a, b) => b[1].createdAt.localeCompare(a[1].createdAt)).slice(0, MAX_ENTRIES);
  cache.entries = Object.fromEntries(ordered);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

function cacheFile(root: string): string { return path.join(root, ".nodenet", "context-cache.json"); }
