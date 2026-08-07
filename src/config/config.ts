/**
 * NodeNet configuration (NodeNet spec §43).
 *
 * Configuration is loaded from `nodenet.config.json` (or YAML), never from
 * executable files. Repository configuration is untrusted input, so it is
 * runtime-validated with Valibot (see docs/adr/002-runtime-validation.md)
 * before anything else reads it.
 */

import fs from "node:fs";
import path from "node:path";
import * as v from "valibot";
import type { Result } from "../types/result.js";
import { ok, err, MalformedConfigError, errorMessage } from "../types/result.js";
import { DEFAULT_LIMITS, type Limits } from "../security/limits.js";
import type { AuthorityLevel } from "../authority/authority.js";
import type { Severity } from "../review/severity.js";
import { SECRET_PATTERNS } from "../security/secrets.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ConfidenceSchema = v.picklist(["AUTHORITATIVE", "DECLARED", "INFERRED", "UNKNOWN"]);

const LimitsSchema = v.object({
  maxFileSizeBytes: v.optional(v.number()),
  maxFiles: v.optional(v.number()),
  maxAstNodesPerFile: v.optional(v.number()),
  maxGraphNodes: v.optional(v.number()),
  maxGraphEdges: v.optional(v.number()),
  maxTraversalDepth: v.optional(v.number()),
  maxTraversalNodes: v.optional(v.number()),
  maxQueryResults: v.optional(v.number()),
  maxContextOutputChars: v.optional(v.number()),
});

const ReviewActionSchema = v.picklist(["informational", "comment", "suggest", "request", "approval", "block"]);

const ReviewPolicySchema = v.object({
  LOW: v.optional(ReviewActionSchema),
  MEDIUM: v.optional(ReviewActionSchema),
  HIGH: v.optional(ReviewActionSchema),
  CRITICAL: v.optional(ReviewActionSchema),
});

const FreshnessSchema = v.object({
  architecture: v.optional(v.string()),
  security: v.optional(v.string()),
  businessRule: v.optional(v.string()),
  complianceRule: v.optional(v.string()),
  default: v.optional(v.string()),
});

const OwnershipOverrideSchema = v.object({
  pattern: v.string(),
  owner: v.string(),
  source: v.optional(v.picklist(["lcdd", "nodenet", "codeowners", "git-history"])),
  confidence: v.optional(ConfidenceSchema),
});

const TeamSchema = v.object({
  name: v.optional(v.string()),
  members: v.optional(v.array(v.string())),
  reviews: v.optional(v.array(v.string())),
});

const DeveloperSchema = v.object({
  handle: v.optional(v.string()),
  team: v.optional(v.string()),
});

const OwnershipConfigSchema = v.object({
  teams: v.optional(v.record(v.string(), TeamSchema)),
  overrides: v.optional(v.array(OwnershipOverrideSchema)),
});

const SuppressionSchema = v.object({
  pattern: v.string(),
  reason: v.string(),
  owner: v.string(),
  createdAt: v.string(),
  expiresAt: v.optional(v.string()),
});

export const ConfigSchema = v.object({
  ignore: v.optional(v.array(v.string())),
  limits: v.optional(LimitsSchema),
  reviewPolicy: v.optional(ReviewPolicySchema),
  contextFreshness: v.optional(FreshnessSchema),
  ownership: v.optional(OwnershipConfigSchema),
  developer: v.optional(DeveloperSchema),
  secretPatterns: v.optional(v.array(v.string())),
  suppressions: v.optional(v.array(SuppressionSchema)),
});

export type NodeNetConfig = v.InferOutput<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Loaded (defaulted) config
// ---------------------------------------------------------------------------

export interface LoadedConfig {
  ignore: string[];
  limits: Limits;
  reviewPolicy: Record<Severity, string>;
  contextFreshness: Record<string, string>;
  ownership: {
    teams: Record<string, { name?: string; members?: string[]; reviews?: string[] }>;
    overrides: { pattern: string; owner: string; source: string; confidence: AuthorityConfidence }[];
  };
  developer: { handle?: string; team?: string };
  secretPatterns: string[];
  suppressions: Suppression[];
}

type AuthorityConfidence = "AUTHORITATIVE" | "DECLARED" | "INFERRED" | "UNKNOWN";

export interface Suppression {
  pattern: string;
  reason: string;
  owner: string;
  createdAt: string;
  expiresAt?: string;
}

export function defaultConfig(): LoadedConfig {
  return {
    ignore: ["dist", "build", "coverage", "node_modules", ".next", "out"],
    limits: { ...DEFAULT_LIMITS },
    reviewPolicy: {
      LOW: "informational",
      MEDIUM: "comment",
      HIGH: "request",
      CRITICAL: "approval",
    },
    contextFreshness: {
      architecture: "180d",
      security: "90d",
      businessRule: "180d",
      complianceRule: "90d",
      default: "180d",
    },
    ownership: { teams: {}, overrides: [] },
    developer: {},
    secretPatterns: [...SECRET_PATTERNS.map((r) => r.source)],
    suppressions: [],
  };
}

export function loadConfig(root: string): Result<LoadedConfig, MalformedConfigError> {
  const configPath = path.join(root, "nodenet.config.json");
  if (!fs.existsSync(configPath)) {
    return ok(defaultConfig());
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    return err(new MalformedConfigError(`Failed to parse nodenet.config.json: ${errorMessage(e)}`));
  }
  const parsed = v.safeParse(ConfigSchema, raw);
  if (!parsed.success) {
    const detail = parsed.issues
      .slice(0, 5)
      .map((issue) => `${issue.path?.map((p) => p.key).join(".") ?? "?"}: ${issue.message}`)
      .join("; ");
    return err(new MalformedConfigError(`Invalid nodenet.config.json: ${detail}`));
  }
  return ok(applyDefaults(parsed.output));
}

function applyDefaults(raw: v.InferOutput<typeof ConfigSchema>): LoadedConfig {
  const def = defaultConfig();

  // review policy: replace per-severity actions that are present
  const reviewPolicy = { ...def.reviewPolicy };
  const rawReview = raw.reviewPolicy;
  if (rawReview) {
    for (const severity of Object.keys(reviewPolicy) as Severity[]) {
      const action = rawReview[severity];
      if (action !== undefined) reviewPolicy[severity] = action;
    }
  }

  // limits: merge only defined values
  const limits = { ...def.limits };
  for (const [key, value] of Object.entries(raw.limits ?? {})) {
    if (typeof value === "number" && key in limits) {
      (limits as Record<string, number>)[key] = value;
    }
  }

  // freshness: merge only defined values
  const contextFreshness: Record<string, string> = { ...def.contextFreshness };
  for (const [key, value] of Object.entries(raw.contextFreshness ?? {})) {
    if (typeof value === "string") contextFreshness[key] = value;
  }

  const overrides = (raw.ownership?.overrides ?? []).map((o) => ({
    pattern: o.pattern,
    owner: o.owner,
    source: o.source ?? "nodenet",
    confidence: (o.confidence ?? "DECLARED") as AuthorityConfidence,
  }));

  // teams: strip undefined fields
  const teams: Record<string, { name?: string; members?: string[]; reviews?: string[] }> = {};
  for (const [teamId, team] of Object.entries(raw.ownership?.teams ?? {})) {
    const cleaned: { name?: string; members?: string[]; reviews?: string[] } = {};
    if (typeof team.name === "string") cleaned.name = team.name;
    if (Array.isArray(team.members)) cleaned.members = team.members;
    if (Array.isArray(team.reviews)) cleaned.reviews = team.reviews;
    teams[teamId] = cleaned;
  }

  const developer: { handle?: string; team?: string } = {};
  const rawDeveloper = raw.developer;
  if (rawDeveloper) {
    if (typeof rawDeveloper.handle === "string") developer.handle = rawDeveloper.handle;
    if (typeof rawDeveloper.team === "string") developer.team = rawDeveloper.team;
  }

  return {
    ignore: [...def.ignore, ...(raw.ignore ?? [])],
    limits,
    reviewPolicy,
    contextFreshness,
    ownership: {
      teams,
      overrides,
    },
    developer,
    secretPatterns: [...def.secretPatterns, ...(raw.secretPatterns ?? [])],
    suppressions: (raw.suppressions ?? []).map((s) => ({
      pattern: s.pattern,
      reason: s.reason,
      owner: s.owner,
      createdAt: s.createdAt,
      ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
    })),
  };
}

/** Parse a duration string like "180d", "90d", "12h", "30m" into ms. */
export function parseDuration(value: string): number {
  const match = /^(\d+)([dhms])$/.exec(value.trim());
  if (!match) return Number.NaN;
  const n = Number(match[1]);
  const unit = match[2];
  if (unit === undefined) return Number.NaN;
  switch (unit) {
    case "d":
      return n * 24 * 60 * 60 * 1000;
    case "h":
      return n * 60 * 60 * 1000;
    case "m":
      return n * 60 * 1000;
    case "s":
      return n * 1000;
    default:
      return Number.NaN;
  }
}

/** Write a starter `nodenet.config.json`. */
export function writeConfigTemplate(root: string): void {
  const template = {
    ignore: ["dist", "build", "coverage", ".next", "out"],
    limits: {
      maxFileSizeBytes: 1048576,
      maxFiles: 10000,
      maxGraphNodes: 100000,
      maxGraphEdges: 300000,
    },
    reviewPolicy: {
      LOW: "informational",
      MEDIUM: "comment",
      HIGH: "request",
      CRITICAL: "approval",
    },
    contextFreshness: {
      architecture: "180d",
      security: "90d",
      businessRule: "180d",
      default: "180d",
    },
    ownership: {
      teams: {
        "payment-team": { name: "Payment Team" },
        "checkout-team": { name: "Checkout Team" },
      },
      overrides: [],
    },
  };
  fs.writeFileSync(path.join(root, "nodenet.config.json"), JSON.stringify(template, null, 2) + "\n");
}

export type { AuthorityLevel };
