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
import { FileRegistry, validateContextFull, type Context as LcddContext } from "@lcdd/core";
import { adaptLcddContext } from "./lcdd.js";

export interface ContextLoadResult {
  contexts: ContextRecord[];
  warnings: string[];
}

const MAX_LCDD_CONTEXT_FILES = 1_000;
const MAX_LCDD_CONTEXT_BYTES = 1_048_576;

function preflightLcddRegistry(contextsDir: string): { issues: string[]; yamlFiles: number } {
  const issues: string[] = [];
  const pending = [contextsDir];
  let files = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const name of fs.readdirSync(current)) {
      const entry = path.join(current, name);
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) {
        issues.push(`LCDD Registry symlink is not allowed: ${path.relative(contextsDir, entry)}`);
        continue;
      }
      if (stat.isDirectory()) {
        pending.push(entry);
        continue;
      }
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      files++;
      if (files > MAX_LCDD_CONTEXT_FILES) {
        issues.push(`LCDD Registry exceeds ${MAX_LCDD_CONTEXT_FILES} Context files.`);
        return { issues, yamlFiles: files };
      }
      if (stat.size > MAX_LCDD_CONTEXT_BYTES) {
        issues.push(`LCDD Context exceeds ${MAX_LCDD_CONTEXT_BYTES} bytes: ${path.relative(contextsDir, entry)}`);
      }
    }
  }
  return { issues, yamlFiles: files };
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
  const byId = new Map<string, ContextRecord>();

  const lcddContextsDir = path.join(root, ".lcdd", "contexts");
  if (fs.existsSync(lcddContextsDir) && fs.statSync(lcddContextsDir).isDirectory()) {
    try {
      const preflight = preflightLcddRegistry(lcddContextsDir);
      if (preflight.issues.length > 0) {
        result.warnings.push(...preflight.issues);
      } else {
        const registry = new FileRegistry(root);
        const canonicalContexts = registry.list();
        if (canonicalContexts.length < preflight.yamlFiles) {
          result.warnings.push(
            `LCDD Registry skipped ${preflight.yamlFiles - canonicalContexts.length} malformed YAML Context file(s).`,
          );
        }
        for (const canonical of canonicalContexts) {
          const validation = validateContextFull(canonical);
          if (!validation.valid) {
            result.warnings.push(`Invalid LCDD 0.6 Context ${canonical.id ?? "(unknown)"}: ${validation.errors.slice(0, 3).join("; ")}`);
            continue;
          }
          const adapted = adaptLcddContext(canonical as LcddContext);
          byId.set(adapted.id, adapted);
        }
      }
    } catch (cause) {
      result.warnings.push(`Cannot load LCDD 0.6 Registry: ${errorMessage(cause)}`);
    }
  }

  const files: string[] = [];
  const single = path.join(dotNodenet, "context.json");
  if (fs.existsSync(single)) files.push(single);
  const dir = path.join(dotNodenet, "contexts");
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith(".json")) files.push(path.join(dir, name));
    }
  }
  if (files.length > 0) {
    result.warnings.push("Deprecated NodeNet Context format detected; migrate .nodenet/context.json to the LCDD 0.6 Registry under .lcdd/contexts/.");
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
      const legacy = {
        ...(parsed.output as unknown as ContextRecord),
        sourceFormat: "nodenet-legacy" as const,
      };
      if (!byId.has(legacy.id)) byId.set(legacy.id, legacy);
    }
  }

  result.contexts = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
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
