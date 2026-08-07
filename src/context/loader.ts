/**
 * Living Context loader (NodeNet spec §6, §7, §34).
 *
 * Context artifacts are loaded from `.nodenet/context.json` or
 * `.nodenet/contexts/*.json`. All external data is runtime-validated
 * (Valibot); invalid artifacts are reported and skipped, never silently
 * coerced.
 */

import fs from "node:fs";
import path from "node:path";
import * as v from "valibot";
import type { Result } from "../types/result.js";
import { ok, errorMessage } from "../types/result.js";
import type { ContextRecord } from "./schema.js";
import { ContextRecordSchema, statusFromLcdd } from "./schema.js";
import { authorityFromGovernance } from "../authority/authority.js";

export interface ContextLoadResult {
  contexts: ContextRecord[];
  warnings: string[];
}

/**
 * Load contexts. Accepts either `.nodenet/context.json` (array) or
 * `.nodenet/contexts/*.json` (each a single record or an array).
 * LCDD-format fields (`lifecycle`, `governance.classification`,
 * `source`) are mapped onto NodeNet's model.
 */
export function loadContexts(root: string): Result<ContextLoadResult, Error> {
  const dotNodenet = path.join(root, ".nodenet");
  const result: ContextLoadResult = { contexts: [], warnings: [] };

  const files: string[] = [];
  const single = path.join(dotNodenet, "context.json");
  if (fs.existsSync(single)) files.push(single);
  const dir = path.join(dotNodenet, "contexts");
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith(".json")) files.push(path.join(dir, name));
    }
  }

  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      result.warnings.push(`Cannot read context file ${file}: ${errorMessage(e)}`);
      continue;
    }
    const records = Array.isArray(raw) ? raw : [raw];
    for (const entry of records) {
      const converted = convertLcddShape(entry);
      const parsed = v.safeParse(ContextRecordSchema, converted);
      if (!parsed.success) {
        const detail = parsed.issues
          .slice(0, 3)
          .map((i) => `${i.path?.map((p) => p.key).join(".") ?? "?"}: ${i.message}`)
          .join("; ");
        result.warnings.push(`Invalid context in ${path.basename(file)}: ${detail}`);
        continue;
      }
      result.contexts.push(parsed.output as unknown as ContextRecord);
    }
  }

  return ok(result);
}

/**
 * Accept LCDD-style shapes: `lifecycle` instead of `status`,
 * `governance.classification` for authority, `source` at top level.
 */
function convertLcddShape(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const raw = input as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  const lcddLifecycle = raw["lifecycle"];
  if (typeof lcddLifecycle === "string") {
    const status = statusFromLcdd(lcddLifecycle);
    if (status && out["status"] === undefined) out["status"] = status;
  }
  const governance = raw["governance"];
  if (typeof governance === "object" && governance !== null) {
    const g = governance as Record<string, unknown>;
    if (typeof g["classification"] === "string" && out["authority"] === undefined) {
      out["authority"] = authorityFromGovernance(g["classification"]);
      out["governanceClassification"] = g["classification"];
    }
  }
  return out;
}
