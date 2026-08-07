/**
 * Context authority (NodeNet spec §8).
 *
 * Authority ranks context so governance decisions can be derived:
 * warnings, reviewer requirements, merge policy recommendations and AI
 * permissions all depend on authority.
 */

export const AUTHORITY_LEVELS = [
  "INFORMATIONAL",
  "GUIDELINE",
  "STANDARD",
  "HARDENED",
  "MANDATORY",
] as const;
export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number];

export const AUTHORITY_RANK: Record<AuthorityLevel, number> = {
  INFORMATIONAL: 1,
  GUIDELINE: 2,
  STANDARD: 3,
  HARDENED: 4,
  MANDATORY: 5,
};

export function authorityRank(level: AuthorityLevel): number {
  return AUTHORITY_RANK[level];
}

/** Hardened+ contexts are immutable to AI agents (LCDD principle). */
export function requiresHumanApproval(level: AuthorityLevel): boolean {
  return AUTHORITY_RANK[level] >= AUTHORITY_RANK.HARDENED;
}

/** Whether a context of this authority can affect merge policy. */
export function isBlockingAuthority(level: AuthorityLevel): boolean {
  return level === "HARDENED" || level === "MANDATORY";
}

export function authorityLabel(level: AuthorityLevel): string {
  switch (level) {
    case "INFORMATIONAL":
      return "informational — no enforcement";
    case "GUIDELINE":
      return "guideline — should be followed";
    case "STANDARD":
      return "standard — reviewer required on impact";
    case "HARDENED":
      return "hardened — immutable to AI, human approval required";
    case "MANDATORY":
      return "mandatory — regulatory/blocking, explicit approval required";
  }
}

/**
 * Map an LCDD governance classification to a NodeNet authority level
 * (LCDD "governance by rate of change", see
 * https://github.com/Lelianto/living-context-driven-development).
 */
export function authorityFromGovernance(
  classification: string,
): AuthorityLevel {
  switch (classification) {
    case "hardened-mandate":
      return "MANDATORY";
    case "hardened-standard":
      return "HARDENED";
    case "hardened-local":
    case "local-standard":
      return "STANDARD";
    case "local-guideline":
      return "GUIDELINE";
    case "local-experimental":
      return "INFORMATIONAL";
    default:
      return "GUIDELINE";
  }
}
