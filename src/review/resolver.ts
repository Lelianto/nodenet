/**
 * Reviewer resolution (NodeNet spec §18, §19, §57, §58).
 *
 * Returns `{ suggested, required, authorityRequired }` with every request
 * explainable. Git-history inference can only ever produce suggestions.
 * Reviewers are deduplicated: a team appearing through CODEOWNERS,
 * ownership and context approval is mentioned once, with all reasons
 * attached (spec §58 — no notification fatigue).
 */

import { authorityRank } from "../authority/authority.js";
import { readCodeowners, gitHistorySuggestion } from "../ownership/resolver.js";
import type { ImpactReport } from "../change/impact.js";
import type { LoadedConfig } from "../config/config.js";
import { matchGlob } from "../utils/glob.js";
import { isActiveContext } from "../context/lcdd.js";

export interface Reviewer {
  target: string;
  reasons: string[];
}

export interface ReviewResolution {
  suggested: Reviewer[];
  required: Reviewer[];
  authorityRequired: Reviewer[];
}

export function resolveReviewers(
  root: string,
  config: LoadedConfig,
  impact: ImpactReport,
): ReviewResolution {
  const suggested = new Map<string, string[]>();
  const required = new Map<string, string[]>();
  const authorityRequired = new Map<string, string[]>();

  const authorTeam = config.developer.team;

  // 1. Ownership of affected code.
  for (const owner of impact.owners) {
    if (authorTeam && owner.owner === authorTeam) continue;
    const reason = `${owner.file} is owned by ${owner.owner} (source: ${owner.source}, confidence: ${owner.confidence.toLowerCase()})`;
    const isDeclared = owner.confidence === "AUTHORITATIVE" || owner.confidence === "DECLARED";
    if (isDeclared) push(required, owner.owner, reason);
    else push(suggested, owner.owner, reason);
  }

  // 2. CODEOWNERS (authoritative, required).
  const codeowners = readCodeowners(root);
  for (const file of impact.affectedFiles) {
    for (const [pattern, owners] of codeowners) {
      if (!matchGlob(pattern, file.toString())) continue;
      for (const owner of owners) {
        if (authorTeam && owner === authorTeam) continue;
        push(required, owner, `CODEOWNERS requires ${owner} for ${pattern} matching ${file.toString()}`);
      }
    }
  }

  // 3. Context authority.
  for (const ctx of impact.affectedContexts) {
    if (!isActiveContext(ctx)) continue;
    const authorityReason = `${ctx.id} (${ctx.title}) is ${ctx.authority}, status ${ctx.status}`;
    for (const approver of ctx.approvedBy) {
      push(authorityRequired, approver, `${ctx.id} requires approval from ${approver} (${authorityReason})`);
    }
    if (ctx.owner) {
      if (authorityRank(ctx.authority) >= 4) {
        push(authorityRequired, ctx.owner, `${ctx.id} (${ctx.authority}) is owned by ${ctx.owner} — hardened context approval required`);
      } else if (authorityRank(ctx.authority) >= 3) {
        push(required, ctx.owner, `${ctx.id} (${ctx.authority}) is owned by ${ctx.owner}`);
      } else {
        push(suggested, ctx.owner, `${ctx.id} (${ctx.authority}) is owned by ${ctx.owner}`);
      }
    }
  }

  // 4. Git history: inference only — "likely reviewer", never required.
  for (const file of impact.changedFiles) {
    const suggestion = gitHistorySuggestion(root, file);
    if (suggestion.ok && suggestion.value) {
      push(suggested, suggestion.value, `Likely reviewer for ${file.toString()} (git-history inference)`);
    }
  }

  // Deduplicate across buckets (spec §58): highest-signal bucket wins.
  for (const target of authorityRequired.keys()) {
    required.delete(target);
    suggested.delete(target);
  }
  for (const target of required.keys()) {
    suggested.delete(target);
  }

  return {
    suggested: toList(suggested),
    required: toList(required),
    authorityRequired: toList(authorityRequired),
  };
}

function push(map: Map<string, string[]>, target: string, reason: string): void {
  const list = map.get(target);
  if (list) {
    if (!list.includes(reason)) list.push(reason);
  } else {
    map.set(target, [reason]);
  }
}

function toList(map: Map<string, string[]>): Reviewer[] {
  return [...map.entries()]
    .map(([target, reasons]) => ({ target, reasons }))
    .sort((a, b) => a.target.localeCompare(b.target));
}
