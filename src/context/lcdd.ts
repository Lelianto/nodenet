/** LCDD 0.6.0 compatibility adapter. */

import type { Context as LcddContext } from "@lcdd/core";
import type { ContextId } from "../types/brand.js";
import type { AuthorityLevel } from "../authority/authority.js";
import type {
  ContextLifecycleStatus,
  ContextProvenanceKind,
  ContextRecord,
  ContextType,
} from "./schema.js";
import { CONTEXT_TYPES, statusFromLcdd } from "./schema.js";

const CATEGORY_TYPES: Record<string, ContextType> = {
  business: "businessRule",
  "business-rule": "businessRule",
  architecture: "architectureDecision",
  "architecture-decision": "architectureDecision",
  security: "securityPolicy",
  "security-policy": "securityPolicy",
  compliance: "complianceRule",
  "compliance-rule": "complianceRule",
  operational: "operationalRule",
  operations: "operationalRule",
  requirement: "requirement",
  specification: "specification",
  convention: "codingConvention",
  "coding-convention": "codingConvention",
  incident: "incidentLearning",
  assumption: "assumption",
  domain: "domainRule",
  "domain-rule": "domainRule",
};

export function authorityFromLcddLevel(level: number): AuthorityLevel {
  switch (level) {
    case 0:
      return "INFORMATIONAL";
    case 1:
      return "GUIDELINE";
    case 2:
      return "STANDARD";
    case 3:
      return "HARDENED";
    case 4:
      return "MANDATORY";
    default:
      return "GUIDELINE";
  }
}

function contextType(context: LcddContext): ContextType {
  const category = context.category?.trim();
  if (category && CONTEXT_TYPES.includes(category as ContextType)) return category as ContextType;
  if (category) {
    const mapped = CATEGORY_TYPES[category.toLowerCase()];
    if (mapped) return mapped;
  }
  return "externalConstraint";
}

function provenanceKind(context: LcddContext): ContextProvenanceKind {
  if (context.source.type === "ai-system" || context.authority.trust_model === "ai-inferred") return "AI_PROPOSED";
  if (context.source.extraction_method === "manual") return "USER_DECLARED";
  if (context.source.type === "regulatory" || context.source.type === "standard-body") return "EXTERNAL";
  if (context.source.extraction_method === "llm" || context.source.extraction_method === "regex") return "DISCOVERED";
  return "FACT";
}

function lifecycle(context: LcddContext): ContextLifecycleStatus {
  return statusFromLcdd(context.lifecycle) ?? "DRAFT";
}

/** Convert the operational view while retaining the complete canonical object. */
export function adaptLcddContext(context: LcddContext): ContextRecord {
  const evidence = (context.evidence ?? []).map((item) =>
    item.uri ?? item.description ?? item.type,
  );
  const createdBy = context.authority.source.id || context.authority.source.name;
  return {
    id: context.id as ContextId,
    version: context.version,
    title: context.title,
    description: context.description,
    type: contextType(context),
    status: lifecycle(context),
    authority: authorityFromLcddLevel(context.authority.level),
    governanceClassification: context.governance.classification,
    approvalRequired: context.governance.approval_required,
    appliesTo: [...(context.applies_to ?? ["**/*"])],
    ...(context.owner !== undefined ? { owner: context.owner } : {}),
    approvedBy: [...(context.governance.approvers ?? [])],
    provenance: {
      source: context.source.type,
      ...(context.source.uri !== undefined ? { sourcePath: context.source.uri } :
        context.source.location !== undefined ? { sourcePath: context.source.location } : {}),
      createdBy,
      createdAt: context.created_at ?? context.effective_date ?? new Date(0).toISOString(),
      ...(context.updated_at !== undefined ? { lastReviewedAt: context.updated_at } : {}),
      kind: provenanceKind(context),
      evidence,
    },
    ...(context.supersedes !== undefined ? { supersedes: context.supersedes as ContextId[] } : {}),
    sourceFormat: "lcdd-0.6",
    ...(context.enforcement !== undefined ? { enforcementMode: context.enforcement.mode } : {}),
    canonical: context,
  };
}

export function isActiveContext(context: ContextRecord): boolean {
  return context.status === "ACTIVE";
}

/** Legacy records preserve their previous authority-derived blocking behavior. */
export function effectiveEnforcementMode(context: ContextRecord): "block" | "warn" | "comment" | "silent" {
  if (context.enforcementMode) return context.enforcementMode;
  if (context.authority === "HARDENED" || context.authority === "MANDATORY") return "block";
  if (context.authority === "STANDARD") return "warn";
  if (context.authority === "GUIDELINE") return "comment";
  return "silent";
}

function lcddAuthorityLevel(level: AuthorityLevel): 0 | 1 | 2 | 3 | 4 {
  switch (level) {
    case "INFORMATIONAL": return 0;
    case "GUIDELINE": return 1;
    case "STANDARD": return 2;
    case "HARDENED": return 3;
    case "MANDATORY": return 4;
  }
}

/** Convert a legacy NodeNet record into a valid canonical LCDD 0.6 artifact. */
export function legacyToLcddContext(context: ContextRecord): LcddContext {
  if (context.canonical) return context.canonical;
  const lifecycleStage = context.status === "NEEDS_REVIEW"
    ? "active"
    : context.status.toLowerCase() as LcddContext["lifecycle"];
  const authorityOwner = context.owner ?? context.provenance.createdBy;
  const enforcementMode = effectiveEnforcementMode(context);
  return {
    id: context.id,
    version: context.version,
    created_at: context.provenance.createdAt,
    ...(context.provenance.lastReviewedAt !== undefined ? { updated_at: context.provenance.lastReviewedAt } : {}),
    title: context.title,
    description: context.description ?? context.title,
    source: {
      type: context.provenance.kind === "EXTERNAL" ? "documentation" : "unknown",
      ...(context.provenance.sourcePath !== undefined ? { location: context.provenance.sourcePath } : {}),
      extraction_method: context.provenance.kind === "USER_DECLARED" ? "manual" : "unknown",
    },
    authority: {
      source: {
        type: "organization",
        id: authorityOwner,
        name: authorityOwner,
      },
      level: lcddAuthorityLevel(context.authority),
      trust_model: context.provenance.kind === "AI_PROPOSED" ? "ai-inferred" : "direct",
    },
    category: context.type,
    applies_to: [...context.appliesTo],
    lifecycle: lifecycleStage,
    governance: {
      classification: context.governanceClassification ?? (
        context.authority === "MANDATORY" ? "hardened-mandate" :
        context.authority === "HARDENED" ? "hardened-standard" :
        context.authority === "STANDARD" ? "local-standard" :
        context.authority === "GUIDELINE" ? "local-guideline" : "local-experimental"
      ),
      approval_required: context.approvalRequired,
      approvers: [...context.approvedBy],
    },
    ...(lifecycleStage === "active" ? { effective_date: context.provenance.createdAt } : {}),
    ...(context.owner !== undefined ? { owner: context.owner } : {}),
    ...(lifecycleStage === "candidate" || lifecycleStage === "approved" ? { review_status: "pending" } : {}),
    enforcement: { mode: enforcementMode },
    evidence: context.provenance.evidence.map((description) => ({ type: "legacy", description })),
    ...(context.supersedes !== undefined ? { supersedes: [...context.supersedes] } : {}),
    metadata: {
      migrated_from: "nodenet-legacy",
      ...(context.status === "NEEDS_REVIEW" ? { nodenet_health_status: "needs-review" } : {}),
    },
  };
}
