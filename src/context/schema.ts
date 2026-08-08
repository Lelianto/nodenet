/**
 * Living Context schema (NodeNet spec §5, §6, §7; LCDD Context Schema).
 *
 * The schema mirrors the LCDD Context artifact
 * (github.com/Lelianto/living-context-driven-development): id, version,
 * title, description, source, authority, lifecycle, governance
 * classification, evidence. Every artifact carries provenance and is never
 * silently upgraded from inference to fact (spec §7).
 */

import * as v from "valibot";
import type { ContextId } from "../types/brand.js";
import type { AuthorityLevel } from "../authority/authority.js";
import type { Context as LcddContext, EnforcementMode as LcddEnforcementMode } from "@lcdd/core";

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const CONTEXT_TYPES = [
  "businessRule",
  "architectureDecision",
  "securityPolicy",
  "codingConvention",
  "requirement",
  "specification",
  "complianceRule",
  "operationalRule",
  "incidentLearning",
  "assumption",
  "domainRule",
  "externalConstraint",
] as const;
export type ContextType = (typeof CONTEXT_TYPES)[number];

export const CONTEXT_STATUSES = [
  "DRAFT",
  "CANDIDATE",
  "APPROVED",
  "ACTIVE",
  "NEEDS_REVIEW",
  "DEPRECATED",
  "ARCHIVED",
] as const;
export type ContextLifecycleStatus = (typeof CONTEXT_STATUSES)[number];

export const PROVENANCE_KINDS = [
  "FACT",
  "INFERRED",
  "DISCOVERED",
  "USER_DECLARED",
  "EXTERNAL",
  "AI_PROPOSED",
] as const;
export type ContextProvenanceKind = (typeof PROVENANCE_KINDS)[number];

export const GOVERNANCE_CLASSIFICATIONS = [
  "hardened-mandate",
  "hardened-standard",
  "hardened-local",
  "local-standard",
  "local-guideline",
  "local-experimental",
] as const;
export type GovernanceClassification = (typeof GOVERNANCE_CLASSIFICATIONS)[number];

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface Provenance {
  /** Where the context came from, e.g. `architecture-decision`. */
  source: string;
  /** Human-readable source path, e.g. `docs/adr/012-authentication.md`. */
  sourcePath?: string;
  createdBy: string;
  createdAt: string;
  lastReviewedAt?: string;
  kind: ContextProvenanceKind;
  evidence: string[];
}

export const ProvenanceSchema = v.object({
  source: v.string(),
  sourcePath: v.optional(v.string()),
  createdBy: v.string(),
  createdAt: v.string(),
  lastReviewedAt: v.optional(v.string()),
  kind: v.picklist(PROVENANCE_KINDS),
  evidence: v.array(v.string()),
});

// ---------------------------------------------------------------------------
// Context record
// ---------------------------------------------------------------------------

export interface ContextRecord {
  id: ContextId;
  version: number;
  title: string;
  description?: string;
  type: ContextType;
  status: ContextLifecycleStatus;
  authority: AuthorityLevel;
  governanceClassification?: GovernanceClassification;
  /** Whether an explicit approval is required to change this context. */
  approvalRequired: boolean;
  /** Globs / symbol names this context applies to. */
  appliesTo: string[];
  /** Team/user responsible for this context. */
  owner?: string;
  /** Teams/users whose approval is required. */
  approvedBy: string[];
  /** Optional per-context freshness override, e.g. `90d`. */
  freshnessPolicy?: string;
  provenance: Provenance;
  conflictsWith?: ContextId[];
  supersedes?: ContextId[];
  /** Canonical source format used to load this record. */
  sourceFormat?: "lcdd-0.6" | "nodenet-legacy";
  /** LCDD enforcement behavior. Legacy records derive this from authority. */
  enforcementMode?: LcddEnforcementMode;
  /** Lossless canonical LCDD artifact when loaded from the LCDD Registry. */
  canonical?: LcddContext;
}

export const ContextRecordSchema = v.object({
  id: v.string(),
  version: v.number(),
  title: v.string(),
  description: v.optional(v.string()),
  type: v.picklist(CONTEXT_TYPES),
  status: v.picklist(CONTEXT_STATUSES),
  authority: v.picklist(["INFORMATIONAL", "GUIDELINE", "STANDARD", "HARDENED", "MANDATORY"]),
  governanceClassification: v.optional(v.picklist(GOVERNANCE_CLASSIFICATIONS)),
  approvalRequired: v.boolean(),
  appliesTo: v.array(v.string()),
  owner: v.optional(v.string()),
  approvedBy: v.array(v.string()),
  freshnessPolicy: v.optional(v.string()),
  provenance: ProvenanceSchema,
  conflictsWith: v.optional(v.array(v.string())),
  supersedes: v.optional(v.array(v.string())),
});

export type ContextRecordInput = v.InferOutput<typeof ContextRecordSchema>;

/** Map an LCDD-style `lifecycle` string to NodeNet statuses. */
export function statusFromLcdd(value: string): ContextLifecycleStatus | undefined {
  const normalized = value.toLowerCase().trim();
  switch (normalized) {
    case "draft":
      return "DRAFT";
    case "candidate":
      return "CANDIDATE";
    case "approved":
      return "APPROVED";
    case "active":
      return "ACTIVE";
    case "needs_review":
    case "needs-review":
      return "NEEDS_REVIEW";
    case "deprecated":
      return "DEPRECATED";
    case "archived":
      return "ARCHIVED";
    default:
      return undefined;
  }
}
