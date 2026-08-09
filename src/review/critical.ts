/** Deterministic, evidence-backed critical review and risk mitigation. */

import type { LoadedConfig } from "../config/config.js";
import type { ImpactReport } from "../change/impact.js";
import type { ReviewResolution } from "./resolver.js";
import type { Severity } from "./severity.js";

export type CriticalReviewDecision = "PROCEED" | "CAUTION" | "BLOCK";
export type RiskPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ReviewRisk {
  id: string;
  priority: RiskPriority;
  finding: string;
  evidence: string[];
  mitigation: string;
  owners: string[];
}

export interface CriticalReview {
  decision: CriticalReviewDecision;
  severity: Severity;
  policyAction: string;
  summary: string;
  risks: ReviewRisk[];
  requiredReviewers: string[];
  authorityReviewers: string[];
  residualRisk: string;
  limitations: string[];
}

const rank: Record<RiskPriority, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/**
 * Turn impact and reviewer evidence into an adversarial review. This function
 * deliberately does not claim semantic correctness: static graph evidence can
 * identify blast radius and governance risk, but cannot prove tests or behavior.
 */
export function buildCriticalReview(
  config: LoadedConfig,
  impact: ImpactReport,
  reviewers: ReviewResolution,
): CriticalReview {
  const risks: ReviewRisk[] = [];
  const required = reviewers.required.map((reviewer) => reviewer.target);
  const authority = reviewers.authorityRequired.map((reviewer) => reviewer.target);

  if (impact.severity === "CRITICAL") {
    risks.push({
      id: "governance-authority",
      priority: "CRITICAL",
      finding: "Changed code is directly governed by hardened or mandatory context.",
      evidence: impact.severityReasons,
      mitigation: authority.length > 0
        ? `Obtain explicit approval from ${authority.join(", ")} and verify every governing constraint before merge.`
        : "Do not merge until an authorized approver is identified and every governing constraint is verified.",
      owners: authority,
    });
  }

  if (impact.crossTeamBoundary) {
    const teams = [...new Set(impact.boundaries.map((boundary) => boundary.toTeam))].sort();
    risks.push({
      id: "cross-team-boundary",
      priority: "HIGH",
      finding: "The change crosses declared ownership boundaries.",
      evidence: impact.boundaries.map((boundary) => `${boundary.fromTeam} -> ${boundary.toTeam} via ${boundary.viaFile}`),
      mitigation: `Request review from the affected owners (${teams.join(", ")}) and validate their integration contracts.`,
      owners: teams,
    });
  }

  const removed = impact.changedSymbols.filter((symbol) => symbol.changeKind === "removed");
  if (removed.length > 0) {
    risks.push({
      id: "removed-symbols",
      priority: "HIGH",
      finding: "Public or internal symbols were removed; downstream compatibility may break.",
      evidence: removed.map((symbol) => `${symbol.relPath}:${symbol.startLine} ${symbol.symbolName}`),
      mitigation: "Confirm all callers were migrated and run compatibility plus regression tests for affected dependants.",
      owners: required,
    });
  }

  const unresolved = impact.changedSymbols.filter((symbol) => !symbol.nodeId);
  if (unresolved.length > 0) {
    risks.push({
      id: "incomplete-symbol-resolution",
      priority: "MEDIUM",
      finding: "Some changes could only be analyzed at file level, reducing impact-analysis confidence.",
      evidence: unresolved.map((symbol) => `${symbol.relPath}:${symbol.startLine}-${symbol.endLine} ${symbol.symbolName}`),
      mitigation: "Manually inspect the full changed files and their callers; add targeted tests for behavior not represented in the graph.",
      owners: required,
    });
  }

  const ownedFiles = new Set(impact.owners.map((owner) => owner.file));
  const unowned = [...impact.changedFiles, ...impact.affectedFiles]
    .map(String)
    .filter((file, index, all) => all.indexOf(file) === index && !ownedFiles.has(file));
  if (unowned.length > 0) {
    risks.push({
      id: "ownership-gap",
      priority: "MEDIUM",
      finding: "Changed or affected files have no declared owner.",
      evidence: unowned,
      mitigation: "Assign a responsible owner before relying on reviewer routing, then obtain that owner's review.",
      owners: [],
    });
  }

  const questionableContexts = impact.affectedContexts.filter((context) =>
    context.status === "NEEDS_REVIEW" || (context.conflictsWith?.length ?? 0) > 0,
  );
  if (questionableContexts.length > 0) {
    risks.push({
      id: "context-quality",
      priority: "HIGH",
      finding: "Governance evidence is stale or declares unresolved conflicts.",
      evidence: questionableContexts.map((context) =>
        `${context.id}: status=${context.status}${context.conflictsWith?.length ? `, conflicts=${context.conflictsWith.join(",")}` : ""}`,
      ),
      mitigation: "Resolve or re-approve the affected context before treating the governance decision as reliable.",
      owners: [...new Set(questionableContexts.flatMap((context) => [context.owner, ...context.approvedBy]).filter((value): value is string => Boolean(value)))],
    });
  }

  risks.sort((a, b) => rank[b.priority] - rank[a.priority] || a.id.localeCompare(b.id));
  const policyAction = config.reviewPolicy[impact.severity];
  const decision: CriticalReviewDecision =
    risks.some((risk) => risk.priority === "CRITICAL") || policyAction === "block"
      ? "BLOCK"
      : risks.some((risk) => rank[risk.priority] >= rank.MEDIUM)
        ? "CAUTION"
        : "PROCEED";

  return {
    decision,
    severity: impact.severity,
    policyAction,
    summary: `${impact.changedFiles.length} changed file(s), ${impact.affectedFiles.length} affected file(s), ${risks.length} identified risk(s).`,
    risks,
    requiredReviewers: required,
    authorityReviewers: authority,
    residualRisk: "Static analysis cannot prove runtime behavior, test adequacy, or the absence of dynamic dependencies.",
    limitations: [
      "Findings are derived from the current git diff and the locally built graph.",
      "Repository context, ownership declarations, and graph freshness determine result quality.",
      "BLOCK is advisory unless repository policy enforces it.",
    ],
  };
}
