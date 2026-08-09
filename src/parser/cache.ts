/** Validated-enough local parse cache used by incremental graph rebuilds. */
import fs from "node:fs";
import path from "node:path";
import type { ParsedFile } from "./typescript.js";
import { isRecord, readJsonFile } from "../utils/validation.js";

export interface CachedParse {
  size: number;
  mtimeMs: number;
  parsed: ParsedFile;
}

export function loadParseCache(root: string): Map<string, CachedParse> {
  const result = new Map<string, CachedParse>();
  const file = path.join(root, ".nodenet", "parse-cache.json");
  if (!fs.existsSync(file)) return result;
  try {
    const raw = readJsonFile(file);
    if (!isRecord(raw)) return result;
    for (const [key, value] of Object.entries(raw)) {
      if (!isRecord(value) || typeof value["size"] !== "number" || typeof value["mtimeMs"] !== "number") continue;
      const parsed = value["parsed"];
      if (!isRecord(parsed) || !Array.isArray(parsed["symbols"])) continue;
      result.set(key, value as unknown as CachedParse);
    }
  } catch { /* corrupt cache causes deterministic reparse */ }
  return result;
}

export function saveParseCache(root: string, cache: Map<string, CachedParse>): void {
  try {
    const dir = path.join(root, ".nodenet");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "parse-cache.json"), JSON.stringify(Object.fromEntries(cache)));
  } catch { /* cache writes are non-fatal */ }
}
