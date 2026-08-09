/** Cross-cutting MCP release controls: freshness, disclosure and output size. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { McpContext } from "./server.js";
import { containsSecrets } from "../security/secrets.js";
import { estimateTokens, DEFAULT_CONTEXT_TOKEN_BUDGET, MAX_CONTEXT_TOKEN_BUDGET } from "../ai/context-builder.js";
import { loadFingerprints } from "../storage/storage.js";

export interface SecuredOutput {
  text: string;
  structuredContent?: Record<string, unknown>;
  estimatedTokens: number;
  truncated: boolean;
}

export interface OutputSecurityOptions {
  budgetTokens?: number;
  secretPatterns?: string[];
  /** Mandatory governance must fail rather than be truncated out of view. */
  failOnOverflow?: boolean;
  toolName?: string;
}

export function secureToolOutput(text: string, options: OutputSecurityOptions = {}): SecuredOutput {
  const inspectionText = stripUnicodeControls(text);
  if (hasSecret(text, options.secretPatterns) || hasSecret(inspectionText, options.secretPatterns)) {
    throw new Error("Output blocked by the secret-disclosure control.");
  }
  const budgetTokens = normalizeBudget(options.budgetTokens);
  const estimatedTokens = estimateTokens(text);
  let value = text;
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(text) as unknown;
    parsedValue = sanitizeValue(parsedValue);
    value = JSON.stringify(parsedValue, null, 2);
  } catch { /* compatibility text is not structured JSON */ }
  if (parsedValue === undefined) value = escapeUnicodeControls(text);
  const structuredContent = parsedValue !== undefined
    ? evidenceEnvelope(parsedValue, options.toolName)
    : undefined;
  if (estimatedTokens <= budgetTokens) {
    return { text: value, estimatedTokens, truncated: false, ...(structuredContent ? { structuredContent } : {}) };
  }
  if (options.failOnOverflow) {
    throw new Error(`Output exceeds the hard ${budgetTokens}-token security limit; narrow the request.`);
  }

  const maxChars = Math.max(0, budgetTokens * 4 - 500);
  const bounded = {
    truncated: true,
    budgetTokens,
    estimatedTokens,
    selectedCharacters: maxChars,
    omittedCharacters: Math.max(0, text.length - maxChars),
    preview: text.slice(0, maxChars),
  };
  value = JSON.stringify(bounded, null, 2);
  if (hasSecret(value, options.secretPatterns)) throw new Error("Output blocked by the secret-disclosure control.");
  return { text: value, structuredContent: evidenceEnvelope(bounded, options.toolName), estimatedTokens, truncated: true };
}

const DANGEROUS_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

function stripUnicodeControls(value: string): string {
  return value.replace(DANGEROUS_UNICODE, "");
}

function escapeUnicodeControls(value: string): string {
  return value.replace(DANGEROUS_UNICODE, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return escapeUnicodeControls(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [escapeUnicodeControls(key), sanitizeValue(entry)]));
  }
  return value;
}

function evidenceEnvelope(data: unknown, toolName: string | undefined): Record<string, unknown> {
  return {
    schemaVersion: "1",
    ...(toolName !== undefined ? { tool: toolName } : {}),
    trust: "untrusted_repository_evidence",
    data,
  };
}

function hasSecret(text: string, patterns: string[] | undefined): boolean {
  if (containsSecrets(text)) return true;
  for (const source of patterns ?? []) {
    try {
      if (unsafeRegexSource(source)) return true;
      if (new RegExp(source).test(text)) return true;
    } catch {
      // Config validation accepts strings, not necessarily valid regular
      // expressions. Invalid patterns fail closed instead of weakening DLP.
      return true;
    }
  }
  return false;
}

/** Conservative guard against repository-configured catastrophic regexes. */
function unsafeRegexSource(source: string): boolean {
  if (source.length === 0 || source.length > 256) return true;
  if (/\\[1-9]/.test(source) || /\(\?(?:[=!]|<[=!])/.test(source)) return true;
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{)/.test(source)) return true;
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{)/.test(source)) return true;
  return false;
}

function normalizeBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONTEXT_TOKEN_BUDGET;
  return Math.min(MAX_CONTEXT_TOKEN_BUDGET, Math.max(256, Math.floor(value)));
}

export interface FreshnessFingerprint { size: number; mtimeMs: number; sha256: string }

const GOVERNANCE_FILES = [
  "nodenet.config.json",
  "CODEOWNERS",
  ".github/CODEOWNERS",
  "docs/CODEOWNERS",
  ".nodenet/context.json",
  ".nodenet/ownership.json",
];
const MAX_FRESHNESS_SCAN_BYTES = 64 * 1024 * 1024;

/** Capture an immutable input snapshot when a transport starts. */
export function captureFreshnessBaseline(ctx: McpContext): Map<string, FreshnessFingerprint> {
  return scanInputs(ctx).files;
}

const RELEVANT = /(?:\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|cs|php|rs|rb|kt|json|ya?ml|md|sql|tf)|CODEOWNERS)$/i;

/** Detect inputs newer than the immutable graph snapshot. */
export function staleInputs(ctx: McpContext): string[] {
  const builtAt = Date.parse(ctx.state.graph.metadata.builtAt);
  if (!Number.isFinite(builtAt)) return ["graph revision has an invalid build timestamp"];
  const scan = scanInputs(ctx);
  const stale = [...scan.errors];
  if (persistedRevisionMatches(ctx)) {
    const persisted = loadFingerprints(ctx.root);
    for (const [file, before] of persisted) {
      const after = scan.files.get(file);
      if (!after) stale.push(`${file} (deleted)`);
      else if (after.size !== before.size || Math.abs(after.mtimeMs - before.mtimeMs) > 1) stale.push(file);
    }
  }
  for (const [file, fingerprint] of scan.files) {
    if (fingerprint.mtimeMs > builtAt + 1) stale.push(file);
  }
  if (ctx.freshnessBaseline) {
    for (const [file, before] of ctx.freshnessBaseline) {
      const after = scan.files.get(file);
      if (!after) stale.push(`${file} (deleted)`);
      else if (after.sha256 !== before.sha256) stale.push(file);
    }
    for (const file of scan.files.keys()) {
      if (!ctx.freshnessBaseline.has(file)) stale.push(`${file} (added)`);
    }
    return [...new Set(stale)].sort().slice(0, 20);
  }

  // Backwards-compatible in-process fallback: this detects modifications
  // after build, while transports use the stronger hash baseline above.
  return [...new Set(stale)].sort().slice(0, 20);
}

function persistedRevisionMatches(ctx: McpContext): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ctx.root, ".nodenet", "metadata.json"), "utf8")) as { builtAt?: unknown };
    return raw.builtAt === ctx.state.graph.metadata.builtAt;
  } catch {
    return false;
  }
}

function scanInputs(ctx: McpContext): { files: Map<string, FreshnessFingerprint>; errors: string[] } {
  const files = new Map<string, FreshnessFingerprint>();
  const errors: string[] = [];
  const pending = [ctx.root];
  let visited = 0;
  let scannedBytes = 0;
  while (pending.length > 0 && visited <= ctx.config.limits.maxFiles && scannedBytes <= MAX_FRESHNESS_SCAN_BYTES) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if ([".git", "node_modules", "dist", "build", "coverage"].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(ctx.root, absolute).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        if (relative === ".nodenet") {
          for (const governed of GOVERNANCE_FILES.filter((file) => file.startsWith(".nodenet/"))) {
            const governedAbsolute = path.join(ctx.root, governed);
            if (fs.existsSync(governedAbsolute)) scannedBytes += addFingerprint(files, governed, governedAbsolute, errors, ctx.config.limits.maxFileSizeBytes);
          }
        } else {
          pending.push(absolute);
        }
        continue;
      }
      if (!RELEVANT.test(relative) && !GOVERNANCE_FILES.includes(relative)) continue;
      visited++;
      try {
        scannedBytes += addFingerprint(files, relative, absolute, errors, ctx.config.limits.maxFileSizeBytes);
      } catch { errors.push(`${relative} (unreadable)`); }
    }
  }
  if (visited > ctx.config.limits.maxFiles) errors.push("input scan exceeded configured maxFiles");
  if (scannedBytes > MAX_FRESHNESS_SCAN_BYTES) errors.push("input scan exceeded the 64 MiB freshness budget");
  return { files, errors };
}

function addFingerprint(
  target: Map<string, FreshnessFingerprint>,
  relative: string,
  absolute: string,
  errors: string[],
  maxFileSizeBytes: number,
): number {
  try {
    const stat = fs.statSync(absolute);
    if (stat.size > maxFileSizeBytes) {
      errors.push(`${relative} (exceeds maxFileSizeBytes)`);
      return 0;
    }
    const content = fs.readFileSync(absolute);
    target.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: crypto.createHash("sha256").update(content).digest("hex") });
    return stat.size;
  } catch {
    errors.push(`${relative} (unreadable)`);
    return 0;
  }
}
