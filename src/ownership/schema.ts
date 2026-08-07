/**
 * Ownership model (NodeNet spec §10, §11).
 *
 * Ownership confidence is explicit and never faked with numeric precision:
 * AUTHORITATIVE (declared in the highest-priority source), DECLARED,
 * INFERRED (e.g. from Git history — suggestions only), UNKNOWN.
 */

export const OWNERSHIP_SOURCES = ["lcdd", "nodenet", "codeowners", "git-history"] as const;
export type OwnershipSource = (typeof OWNERSHIP_SOURCES)[number];

export const OWNERSHIP_CONFIDENCES = ["AUTHORITATIVE", "DECLARED", "INFERRED", "UNKNOWN"] as const;
export type OwnershipConfidence = (typeof OWNERSHIP_CONFIDENCES)[number];

export interface OwnershipRecord {
  /** Glob pattern the ownership applies to (e.g. `src/payment/**`). */
  pattern: string;
  /** Team or person handle, e.g. `payment-team` or `@alice`. */
  owner: string;
  source: OwnershipSource;
  confidence: OwnershipConfidence;
}

/**
 * Explicit priority: LCDD context metadata > NodeNet explicit ownership >
 * CODEOWNERS > Git history inference (spec §10).
 */
export const SOURCE_PRIORITY: Record<OwnershipSource, number> = {
  lcdd: 0,
  nodenet: 1,
  codeowners: 2,
  "git-history": 3,
};

export const CONFIDENCE_RANK: Record<OwnershipConfidence, number> = {
  AUTHORITATIVE: 3,
  DECLARED: 2,
  INFERRED: 1,
  UNKNOWN: 0,
};
