import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { GovernanceDecision } from "./decision.js";
import { appendAudit, dotNodenetDir, ensureDotNodenet } from "../storage/storage.js";
import type { IdentityAssurance, VerifiedIdentity } from "../identity/identity.js";

export interface DecisionOverride {
  decisionId: string;
  actor: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  identityAssurance?: IdentityAssurance;
  verifiedActor?: VerifiedIdentity;
}

export interface DecisionAuditInput {
  decision: GovernanceDecision;
  repository?: string;
  pullRequest?: number;
  override?: DecisionOverride;
}

export function decisionFingerprint(value: Omit<GovernanceDecision, "decisionId">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function isOverrideActive(override: DecisionOverride, now = new Date()): boolean {
  return override.decisionId.length > 0 && new Date(override.expiresAt).getTime() > now.getTime();
}

export function applyDecisionOverride(
  decision: GovernanceDecision,
  override: DecisionOverride,
  now = new Date(),
): GovernanceDecision {
  if (override.decisionId !== decision.decisionId) throw new Error("Override does not match this decision.");
  if (!override.actor.trim() || !override.reason.trim()) throw new Error("Override actor and reason are required.");
  if (!isOverrideActive(override, now)) throw new Error("Override is expired or has an invalid expiry.");
  return { ...decision, shouldFail: false, overridden: true, override };
}

export function saveOverride(root: string, override: DecisionOverride): void {
  ensureDotNodenet(root);
  const file = path.join(dotNodenetDir(root), "overrides.jsonl");
  fs.appendFileSync(file, JSON.stringify(override) + "\n", { mode: 0o600 });
}

export function appendDecisionAudit(root: string, input: DecisionAuditInput): void {
  appendAudit(root, {
    type: "governance-decision",
    at: new Date().toISOString(),
    decisionId: input.decision.decisionId,
    schemaVersion: input.decision.schemaVersion,
    engineVersion: input.decision.engineVersion,
    lcddVersion: input.decision.lcddVersion,
    mode: input.decision.mode,
    outcome: input.decision.outcome,
    shouldFail: input.decision.shouldFail,
    overridden: input.decision.overridden,
    changedFileCount: input.decision.changedFiles.length,
    affectedContextCount: input.decision.affectedContexts.length,
    ...(input.repository ? { repository: input.repository } : {}),
    ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
    ...(input.override ? {
      overrideActor: input.override.actor,
      identityAssurance: input.override.identityAssurance ?? "claimed",
      ...(input.override.verifiedActor ? {
        verifiedGithubUserId: input.override.verifiedActor.providerUserId,
        verifiedGithubLogin: input.override.verifiedActor.login,
      } : {}),
      overrideReason: input.override.reason,
      overrideExpiresAt: input.override.expiresAt,
    } : {}),
  });
}
