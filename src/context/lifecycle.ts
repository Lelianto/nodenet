/**
 * Living Context lifecycle (NodeNet spec §6).
 *
 * Transitions are explicit and validated — arbitrary transitions fail
 * unless allowed by policy. The lifecycle mirrors LCDD's six stages
 * (Draft → Candidate → Approved → Active → Deprecated → Archived) plus the
 * NodeNet NEEDS_REVIEW state used for context freshness/decay (spec §26).
 */

import type { Result } from "../types/result.js";
import { ok, err, InvalidTransitionError } from "../types/result.js";
import type { ContextLifecycleStatus, ContextRecord } from "./schema.js";
import { CONTEXT_STATUSES } from "./schema.js";

/** Allowed transitions (spec §6). */
export const TRANSITIONS: Record<ContextLifecycleStatus, readonly ContextLifecycleStatus[]> = {
  DRAFT: ["CANDIDATE"],
  CANDIDATE: ["APPROVED", "DRAFT"],
  APPROVED: ["ACTIVE", "DRAFT"],
  ACTIVE: ["NEEDS_REVIEW", "DEPRECATED"],
  NEEDS_REVIEW: ["ACTIVE", "DEPRECATED"],
  DEPRECATED: ["ARCHIVED", "ACTIVE"],
  ARCHIVED: ["CANDIDATE"],
};

export function canTransition(from: ContextLifecycleStatus, to: ContextLifecycleStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** List every permitted transition as `FROM -> TO` pairs. */
export function allTransitions(): string[] {
  const out: string[] = [];
  for (const from of CONTEXT_STATUSES) {
    for (const to of TRANSITIONS[from]) {
      out.push(`${from} -> ${to}`);
    }
  }
  return out;
}

export interface TransitionAuditEvent {
  type: "context.transition";
  contextId: string;
  from: ContextLifecycleStatus;
  to: ContextLifecycleStatus;
  by: string;
  at: string;
  /** True when the transition bypassed policy via --force (needs post-hoc review). */
  forced: boolean;
}

/**
 * Transition a context to a new status. Returns the updated record plus an
 * audit event. `ACTIVE -> DRAFT` (and every non-listed pair) fails unless
 * `force` is set — forced transitions are still audited and must be
 * approved post-hoc (LCDD "emergency shortcuts exist but require post-hoc
 * review").
 */
export function transitionContext(
  record: ContextRecord,
  to: ContextLifecycleStatus,
  by: string,
  force = false,
): Result<{ record: ContextRecord; audit: TransitionAuditEvent }, InvalidTransitionError> {
  const from = record.status;
  if (from === to) {
    return err(new InvalidTransitionError(`Context ${record.id} is already ${from}.`));
  }
  if (!canTransition(from, to)) {
    if (!force) {
      return err(
        new InvalidTransitionError(
          `Invalid lifecycle transition ${from} -> ${to} for context ${record.id}. ` +
            `Allowed: ${TRANSITIONS[from].join(", ") || "none"}. Use --force only for audited emergency changes.`,
        ),
      );
    }
  }
  const updated: ContextRecord = {
    ...record,
    status: to,
    provenance: {
      ...record.provenance,
      lastReviewedAt: new Date().toISOString(),
    },
  };
  const audit: TransitionAuditEvent = {
    type: "context.transition",
    contextId: record.id,
    from,
    to,
    by,
    at: new Date().toISOString(),
    forced: force && !canTransition(from, to),
  };
  return ok({ record: updated, audit });
}

/**
 * Apply context decay (spec §26): ACTIVE contexts whose freshness policy
 * threshold was exceeded move to NEEDS_REVIEW. Expiration never
 * auto-deletes or disables context.
 */
export function applyDecay(
  record: ContextRecord,
  freshnessMs: number,
  now: Date = new Date(),
): ContextRecord {
  if (record.status !== "ACTIVE") return record;
  const lastReviewed = record.provenance.lastReviewedAt ?? record.provenance.createdAt;
  const last = new Date(lastReviewed).getTime();
  if (Number.isNaN(last)) return record;
  if (now.getTime() - last > freshnessMs) {
    return { ...record, status: "NEEDS_REVIEW" };
  }
  return record;
}
