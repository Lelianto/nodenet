/**
 * Context health (NodeNet spec §25, §26).
 *
 * Every metric is derived from actual graph state — nothing is fabricated.
 * Context freshness (decay) moves ACTIVE contexts to NEEDS_REVIEW when
 * their review threshold is exceeded; it never deletes or disables.
 */

import type { Graph } from "../graph/graph.js";
import type { SafeRelativePath } from "../security/filesystem.js";
import type { ContextRecord, ContextLifecycleStatus } from "../context/schema.js";
import { CONTEXT_STATUSES } from "../context/schema.js";
import { authorityRank } from "../authority/authority.js";
import type { OwnershipIndex } from "../ownership/resolver.js";
import type { LoadedConfig } from "../config/config.js";
import { parseDuration } from "../config/config.js";
import { matchGlob } from "../utils/glob.js";

export interface HealthReport {
  timestamp: string;
  contexts: {
    total: number;
    byStatus: Partial<Record<ContextLifecycleStatus, number>>;
    conflicts: number;
    orphan: number;
  };
  ownershipCoverage: number;
  /** Repository-relative file paths with no resolved owner. */
  unownedFiles: string[];
  authorityCoverage: number;
  warnings: string[];
  metrics: {
    staleActive: number;
    missingOwner: number;
    unreviewedHardened: number;
    codeWithoutOwner: number;
  };
}

export function computeHealth(
  graph: Graph,
  contexts: ContextRecord[],
  ownershipIndex: OwnershipIndex,
  config: LoadedConfig,
  now: Date = new Date(),
): HealthReport {
  const warnings: string[] = [];
  const byStatus: Partial<Record<ContextLifecycleStatus, number>> = {};
  for (const status of CONTEXT_STATUSES) byStatus[status] = 0;

  let conflicts = 0;
  let orphan = 0;
  let staleActive = 0;
  let missingOwner = 0;
  let unreviewedHardened = 0;

  const fileNodes = graph.findNodes((n) => n.kind === "file");
  const filePaths: SafeRelativePath[] = fileNodes.map((n) => (n as { path: SafeRelativePath }).path);

  for (const ctx of contexts) {
    byStatus[ctx.status] = (byStatus[ctx.status] ?? 0) + 1;

    if (ctx.status === "ACTIVE") {
      // decay: freshness threshold per context type, with default fallback
      const policy =
        ctx.freshnessPolicy ??
        config.contextFreshness[ctx.type] ??
        config.contextFreshness["default"] ??
        "180d";
      const ms = parseDuration(policy);
      const lastReviewed = ctx.provenance.lastReviewedAt ?? ctx.provenance.createdAt;
      const last = new Date(lastReviewed).getTime();
      if (!Number.isNaN(ms) && !Number.isNaN(last) && now.getTime() - last > ms) {
        staleActive++;
        warnings.push(`ACTIVE context ${ctx.id} has not been reviewed within policy (${policy}).`);
      }
    }

    if (ctx.status !== "ARCHIVED" && !ctx.owner) {
      missingOwner++;
      warnings.push(`Context ${ctx.id} has no owner.`);
    }

    if (ctx.status === "ACTIVE" && (ctx.authority === "HARDENED" || ctx.authority === "MANDATORY")) {
      const reviewedAt = ctx.provenance.lastReviewedAt ?? ctx.provenance.createdAt;
      if (!ctx.provenance.lastReviewedAt) {
        unreviewedHardened++;
        warnings.push(`HARDENED context ${ctx.id} has never been reviewed.`);
      } else {
        const policy = ctx.freshnessPolicy ?? "90d";
        const ms = parseDuration(policy);
        if (!Number.isNaN(ms) && now.getTime() - new Date(reviewedAt).getTime() > ms) {
          unreviewedHardened++;
          warnings.push(`HARDENED context ${ctx.id} has not been reviewed within policy.`);
        }
      }
    }

    if (ctx.conflictsWith && ctx.conflictsWith.length > 0) conflicts++;

    // orphan: appliesTo matches no files
    const matchesAny = ctx.appliesTo.some((pattern) => filePaths.some((p) => matchGlob(pattern, p.toString())));
    if (!matchesAny && ctx.status !== "ARCHIVED") {
      orphan++;
      warnings.push(`Context ${ctx.id} applies to no code (orphan context).`);
    }
  }

  // ownership coverage: files with a declared owner / total files
  const unownedFiles = filePaths.filter((p) => ownershipIndex.resolveOwner(p) === null).map((p) => p.toString()).sort();
  const ownedFiles = filePaths.length - unownedFiles.length;
  const ownershipCoverage = filePaths.length === 0 ? 0 : Math.round((ownedFiles / filePaths.length) * 1000) / 10;
  const codeWithoutOwner = filePaths.length - ownedFiles;

  // authority coverage: active contexts with authority >= STANDARD
  const active = contexts.filter((c) => c.status === "ACTIVE");
  const strong = active.filter((c) => authorityRank(c.authority) >= 3).length;
  const authorityCoverage = active.length === 0 ? 0 : Math.round((strong / active.length) * 1000) / 10;

  return {
    timestamp: now.toISOString(),
    contexts: {
      total: contexts.length,
      byStatus,
      conflicts,
      orphan,
    },
    ownershipCoverage,
    unownedFiles,
    authorityCoverage,
    warnings,
    metrics: {
      staleActive,
      missingOwner,
      unreviewedHardened,
      codeWithoutOwner,
    },
  };
}
