/**
 * Review severity (NodeNet spec §16, §17).
 *
 * Severity is derived from the impact report and drives the review policy:
 * LOW → informational, MEDIUM → comment/suggestion, HIGH → review request,
 * CRITICAL → required approval. NodeNet never blocks merges on its own —
 * that is repository-policy controlled (spec §17, §59).
 */

import type { ContextRecord } from "../context/schema.js";
import { isBlockingAuthority } from "../authority/authority.js";
import { matchGlob } from "../utils/glob.js";

export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface SeverityInput {
  /** Paths that were directly changed. */
  changedFiles: string[];
  /** Contexts affected by the change. */
  affectedContexts: ContextRecord[];
  /** Whether the change crosses an ownership boundary. */
  crossTeamBoundary: boolean;
}

/**
 * Deterministic severity derivation:
 * - CRITICAL: a hardened/mandatory context directly governs changed code.
 * - HIGH: the change crosses an ownership boundary (cross-team).
 * - MEDIUM: only indirect dependencies are affected.
 * - LOW: purely internal change.
 */
export function computeSeverity(input: SeverityInput): { severity: Severity; reasons: string[] } {
  const reasons: string[] = [];

  for (const ctx of input.affectedContexts) {
    if (!isBlockingAuthority(ctx.authority)) continue;
    const directlyChanged = ctx.appliesTo.some((pattern) =>
      input.changedFiles.some((file) => matchGlob(pattern, file)),
    );
    if (directlyChanged) {
      reasons.push(
        `${ctx.id} (${ctx.title}) is ${ctx.authority} and directly governs changed code.`,
      );
      return { severity: "CRITICAL", reasons };
    }
  }

  if (input.crossTeamBoundary) {
    reasons.push("The change crosses an ownership boundary between teams.");
    return { severity: "HIGH", reasons };
  }

  if (input.affectedContexts.length > 0) {
    reasons.push(`Change affects governed code (${input.affectedContexts.map((c) => c.id).join(", ")}).`);
    return { severity: "MEDIUM", reasons };
  }

  reasons.push("Internal implementation change with no cross-team or governance impact.");
  return { severity: "LOW", reasons };
}
