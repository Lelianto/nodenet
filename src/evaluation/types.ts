import type { GovernanceDecision, GovernanceOutcome } from "../governance/decision.js";

export const FEEDBACK_CLASSES = ["correct", "false-positive", "wrong-reviewer", "missed-impact", "excluded"] as const;
export type FeedbackClass = (typeof FEEDBACK_CLASSES)[number];

export interface HistoricalPullRequest {
  schemaVersion: "1";
  provider: "github";
  repository: string;
  repositoryId?: number;
  number: number;
  title: string;
  url: string;
  authorGithubId?: number;
  authorLogin?: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  state: "open" | "closed";
  merged: boolean;
  mergedAt?: string;
  requestedReviewers: string[];
  submittedReviewers: string[];
  importedAt: string;
}

export interface EvaluationDataset {
  schemaVersion: "1";
  id: string;
  repository: string;
  createdAt: string;
  cases: HistoricalPullRequest[];
}

export interface EvaluationLabel {
  schemaVersion: "1";
  datasetId: string;
  pullRequest: number;
  expectedOutcome: GovernanceOutcome;
  expectedReviewers: string[];
  hardenedImpactExpected: boolean;
  feedbackClass: FeedbackClass;
  confidence: "low" | "medium" | "high";
  notes: string;
  labeler: string;
  createdAt: string;
}

export interface EvaluationCaseRun {
  pullRequest: number;
  decision?: GovernanceDecision;
  durationMs: number;
  error?: string;
  runAt: string;
}

export interface EvaluationRun {
  schemaVersion: "1";
  id: string;
  datasetId: string;
  startedAt: string;
  completedAt: string;
  cases: EvaluationCaseRun[];
}
