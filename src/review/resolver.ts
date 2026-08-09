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
  score: number;
  evidenceScope: "direct" | "transitive" | "inferred";
}

export interface ReviewResolution {
  suggested: Reviewer[];
  required: Reviewer[];
  authorityRequired: Reviewer[];
  informational: Reviewer[];
}

export function resolveReviewers(
  root: string,
  config: LoadedConfig,
  impact: ImpactReport,
): ReviewResolution {
  const suggested = new Map<string, string[]>();
  const required = new Map<string, string[]>();
  const authorityRequired = new Map<string, string[]>();
  const informational = new Map<string, string[]>();

  const authorTeam = config.developer.team;

  const approvalFiles = new Set(impact.approvalFiles.map((file) => file.toString()));

  // 1. Direct ownership defines approval. Transitive ownership is evidence,
  // not an automatic approval obligation.
  for (const owner of impact.owners) {
    if (authorTeam && owner.owner === authorTeam) continue;
    const reason = `${owner.file} is owned by ${owner.owner} (source: ${owner.source}, confidence: ${owner.confidence.toLowerCase()})`;
    const isDeclared = owner.confidence === "AUTHORITATIVE" || owner.confidence === "DECLARED";
    if (isDeclared && approvalFiles.has(owner.file)) push(required, owner.owner, `Approval radius: ${reason}`);
    else if (isDeclared) push(informational, owner.owner, `Transitive blast radius: ${reason}`);
    else push(suggested, owner.owner, reason);
  }

  // 2. CODEOWNERS (authoritative, required).
  const codeowners = readCodeowners(root);
  for (const file of [...impact.changedFiles, ...impact.affectedFiles]) {
    for (const [pattern, owners] of codeowners) {
      if (!matchGlob(pattern, file.toString())) continue;
      for (const owner of owners) {
        if (authorTeam && owner === authorTeam) continue;
        const reason = `CODEOWNERS requires ${owner} for ${pattern} matching ${file.toString()}`;
        if (approvalFiles.has(file.toString())) push(required, owner, `Approval radius: ${reason}`);
        else push(informational, owner, `Transitive blast radius: ${reason}`);
      }
    }
  }

  // 3. Context authority.
  const directContextIds = new Set(impact.directContexts.map((context) => context.id));
  for (const ctx of impact.affectedContexts) {
    if (!isActiveContext(ctx)) continue;
    const authorityReason = `${ctx.id} (${ctx.title}) is ${ctx.authority}, status ${ctx.status}`;
    const direct = directContextIds.has(ctx.id);
    for (const approver of ctx.approvedBy) {
      if (direct) push(authorityRequired, approver, `${ctx.id} directly governs a changed file and requires approval from ${approver} (${authorityReason})`);
      else push(informational, approver, `${ctx.id} is transitive-only; ${approver} is informed, not required (${authorityReason})`);
    }
    if (ctx.owner) {
      if (!direct) {
        push(informational, ctx.owner, `${ctx.id} (${ctx.authority}) is reached only through transitive blast radius`);
      } else if (authorityRank(ctx.authority) >= 4) {
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
    informational.delete(target);
  }
  for (const target of required.keys()) {
    suggested.delete(target);
    informational.delete(target);
  }
  for (const target of suggested.keys()) informational.delete(target);

  return {
    suggested: toList(suggested, 0.45, "inferred"),
    required: toList(required, 0.85, "direct"),
    authorityRequired: toList(authorityRequired, 1, "direct"),
    informational: toList(informational, 0.2, "transitive"),
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

function toList(map: Map<string, string[]>, score: number, evidenceScope: Reviewer["evidenceScope"]): Reviewer[] {
  return [...map.entries()]
    .map(([target, reasons]) => ({ target, reasons, score, evidenceScope }))
    .sort((a, b) => a.target.localeCompare(b.target));
}
