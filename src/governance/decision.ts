/**
 * Stable, machine-readable governance decision composed from impact and
 * reviewer resolution. This is the contract consumed by CI integrations.
 */

import type { ImpactReport } from "../change/impact.js";
import type { ReviewResolution } from "../review/resolver.js";
import { isBlockingReview } from "../github/comment.js";
import { effectiveEnforcementMode, isActiveContext } from "../context/lcdd.js";
import { decisionFingerprint, type DecisionOverride } from "./audit.js";
import { NODENET_VERSION } from "../version.js";

export const GOVERNANCE_DECISION_SCHEMA_VERSION = "1" as const;
export const GOVERNANCE_MODES = ["observe", "warn", "enforce"] as const;
export type GovernanceMode = (typeof GOVERNANCE_MODES)[number];
export type GovernanceOutcome = "pass" | "warn" | "block";

export interface ContextEvidence {
  id: string;
  version: number;
  title: string;
  status: string;
  authority: string;
  approvalRequired: boolean;
  approvers: string[];
  appliesTo: string[];
  enforcementMode: "block" | "warn" | "comment" | "silent";
  sourceFormat: "lcdd-0.6" | "nodenet-legacy";
}

export interface ApprovalRequirement {
  target: string;
  kind: "required" | "authority";
  reasons: string[];
}

export interface GovernanceDecision {
  decisionId: string;
  schemaVersion: typeof GOVERNANCE_DECISION_SCHEMA_VERSION;
  engineVersion: string;
  lcddVersion: "0.6.0";
  mode: GovernanceMode;
  outcome: GovernanceOutcome;
  shouldFail: boolean;
  severity: ImpactReport["severity"];
  reasons: string[];
  changedFiles: string[];
  affectedFiles: string[];
  affectedContexts: ContextEvidence[];
  ownershipBoundaries: ImpactReport["boundaries"];
  requiredApprovals: ApprovalRequirement[];
  overridden: boolean;
  override?: DecisionOverride;
}

export function isGovernanceMode(value: string): value is GovernanceMode {
  return GOVERNANCE_MODES.includes(value as GovernanceMode);
}

/**
 * Derive the policy outcome independently from rollout mode. Only enforce mode
 * turns a blocking outcome into a failing process exit code.
 */
export function buildGovernanceDecision(
  impact: ImpactReport,
  review: ReviewResolution,
  mode: GovernanceMode = "warn",
): GovernanceDecision {
  const blocking = isBlockingReview(impact, review);
  const hasReviewSignal = review.required.length > 0 || review.authorityRequired.length > 0;
  const outcome: GovernanceOutcome = blocking ? "block" : hasReviewSignal || impact.severity !== "LOW" ? "warn" : "pass";

  const requiredApprovals: ApprovalRequirement[] = [
    ...review.required.map((item) => ({
      target: item.target,
      kind: "required" as const,
      reasons: [...item.reasons],
    })),
    ...review.authorityRequired.map((item) => ({
      target: item.target,
      kind: "authority" as const,
      reasons: [...item.reasons],
    })),
  ].sort((a, b) => a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind));
  const ownershipBoundaries = [...new Map(
    impact.boundaries.map((boundary) => [
      `${boundary.fromTeam}\u0000${boundary.toTeam}\u0000${boundary.viaFile}`,
      boundary,
    ]),
  ).values()].sort(
    (a, b) => a.viaFile.localeCompare(b.viaFile) || a.toTeam.localeCompare(b.toTeam),
  );

  const decision: Omit<GovernanceDecision, "decisionId"> = {
    schemaVersion: GOVERNANCE_DECISION_SCHEMA_VERSION,
    engineVersion: NODENET_VERSION,
    lcddVersion: "0.6.0",
    mode,
    outcome,
    shouldFail: mode === "enforce" && outcome === "block",
    severity: impact.severity,
    reasons: [...impact.severityReasons],
    changedFiles: impact.changedFiles.map((file) => file.toString()).sort(),
    affectedFiles: impact.affectedFiles.map((file) => file.toString()).sort(),
    affectedContexts: impact.affectedContexts
      .filter(isActiveContext)
      .map((context) => ({
        id: context.id,
        version: context.version,
        title: context.title,
        status: context.status,
        authority: context.authority,
        approvalRequired: context.approvalRequired,
        approvers: [...context.approvedBy].sort(),
        appliesTo: [...context.appliesTo].sort(),
        enforcementMode: effectiveEnforcementMode(context),
        sourceFormat: context.sourceFormat ?? "nodenet-legacy",
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    ownershipBoundaries,
    requiredApprovals,
    overridden: false,
  };
  return { decisionId: decisionFingerprint(decision), ...decision };
}
