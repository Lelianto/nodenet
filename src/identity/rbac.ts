import fs from "node:fs";
import path from "node:path";
import type { GovernanceDecision } from "../governance/decision.js";
import type { VerifiedIdentity } from "./identity.js";
import { isRecord, isStringArray, readJsonFile } from "../utils/validation.js";

export const NODENET_ROLES = ["viewer", "labeler", "context-owner", "security-approver", "override-approver", "organization-admin"] as const;
export type NodeNetRole = (typeof NODENET_ROLES)[number];

export interface RoleBinding {
  githubUserId: number;
  role: NodeNetRole;
  repositories: string[];
  contextPatterns: string[];
  expiresAt?: string;
}
export interface AccessPolicy { schemaVersion: "1"; bindings: RoleBinding[] }

export function loadAccessPolicy(root: string): AccessPolicy | undefined {
  const file = path.join(root, ".nodenet", "access.json");
  if (!fs.existsSync(file)) return undefined;
  const raw = readJsonFile(file);
  if (!isRecord(raw) || raw["schemaVersion"] !== "1" || !Array.isArray(raw["bindings"])) {
    throw new Error("Invalid .nodenet/access.json policy.");
  }
  const bindings = raw["bindings"].map(parseRoleBinding);
  return { schemaVersion: "1", bindings };
}

function parseRoleBinding(value: unknown, index: number): RoleBinding {
  if (!isRecord(value)) throw new Error(`Invalid access policy binding at index ${index}: expected an object.`);
  const userId = value["githubUserId"];
  const role = value["role"];
  const repositories = value["repositories"];
  const contextPatterns = value["contextPatterns"];
  const expiresAt = value["expiresAt"];
  if (!Number.isSafeInteger(userId) || (userId as number) <= 0) throw new Error(`Invalid access policy binding at index ${index}: githubUserId must be a positive integer.`);
  if (typeof role !== "string" || !(NODENET_ROLES as readonly string[]).includes(role)) throw new Error(`Invalid access policy binding at index ${index}: unknown role.`);
  if (!isStringArray(repositories) || !isStringArray(contextPatterns)) throw new Error(`Invalid access policy binding at index ${index}: repository and context patterns must be string arrays.`);
  if (expiresAt !== undefined && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)))) throw new Error(`Invalid access policy binding at index ${index}: expiresAt must be a valid date.`);
  return {
    githubUserId: userId as number,
    role: role as NodeNetRole,
    repositories,
    contextPatterns,
    ...(typeof expiresAt === "string" ? { expiresAt } : {}),
  };
}

export function authorizeOverride(policy: AccessPolicy, identity: VerifiedIdentity, repository: string, decision: GovernanceDecision, now = new Date()): { allowed: boolean; reason: string } {
  const contextIds = decision.affectedContexts.map((context) => context.id);
  const binding = policy.bindings.find((item) =>
    item.githubUserId === identity.providerUserId && item.role === "override-approver" &&
    (item.expiresAt === undefined || new Date(item.expiresAt).getTime() > now.getTime()) &&
    item.repositories.some((pattern) => matches(pattern, repository)) &&
    (contextIds.length === 0 || contextIds.every((id) => item.contextPatterns.some((pattern) => matches(pattern, id)))),
  );
  return binding ? { allowed: true, reason: "verified override-approver binding matches repository and Context scope" } : { allowed: false, reason: "no active override-approver binding matches this GitHub user, repository, and Context scope" };
}

function matches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
