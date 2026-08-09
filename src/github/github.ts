/**
 * GitHub pull-request integration (NodeNet spec §57).
 *
 * High-level orchestration: analyze a PR's impact against the current
 * checkout, resolve reviewers, build the Markdown comment, then (optionally)
 * post the comment and request reviewers via the GitHub REST API.
 *
 * The checkout must be a git working tree at the PR head; `base` is the
 * target branch. Review requests only ever include *declared* reviewers
 * (required + authority-required) — never git-history suggestions
 * (spec §57: inference is never a required reviewer).
 */

import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { Graph } from "../graph/graph.js";
import type { CodeGraphIndex } from "../analyzer/code-graph.js";
import type { ContextRecord } from "../context/schema.js";
import type { OwnershipIndex } from "../ownership/resolver.js";
import type { LoadedConfig } from "../config/config.js";
import { analyzeImpact, type ImpactReport } from "../change/impact.js";
import { resolveReviewers, type ReviewResolution } from "../review/resolver.js";
import type { AnalysisState } from "../types/analysis-state.js";
import { buildPrComment } from "./comment.js";
import {
  parseRepo,
  resolveGitHubToken,
  defaultApiUrl,
  upsertIssueComment,
  requestReviewers,
  upsertCheckRun,
} from "./client.js";
import { appendDecisionAudit, applyDecisionOverride, saveOverride, type DecisionOverride } from "../governance/audit.js";
import { authorizeOverride, loadAccessPolicy } from "../identity/rbac.js";
import {
  buildGovernanceDecision,
  type GovernanceDecision,
  type GovernanceMode,
} from "../governance/decision.js";

export interface PrAnalyzeOptions {
  base?: string;
  authorTeam?: string;
  enforcePolicy?: boolean;
  mode?: GovernanceMode;
}

export interface PrAnalyzeResult {
  impact: ImpactReport;
  review: ReviewResolution;
  decision: GovernanceDecision;
  comment: string;
}

/** Analyze a PR change set and produce the impact report + comment. */
export function analyzePr(
  root: string,
  config: LoadedConfig,
  graph: Graph,
  index: CodeGraphIndex,
  ownership: OwnershipIndex,
  contexts: ContextRecord[],
  opts: PrAnalyzeOptions = {},
): Result<PrAnalyzeResult, Error> {
  const impact = analyzeImpact(root, config, graph, index, ownership, contexts, {
    ...(opts.base !== undefined ? { base: opts.base } : {}),
    ...(opts.authorTeam !== undefined ? { developerTeam: opts.authorTeam } : {}),
  });
  if (!impact.ok) return impact;
  const review = resolveReviewers(root, config, impact.value);
  const decision = buildGovernanceDecision(impact.value, review, opts.mode ?? "warn");
  const comment = buildPrComment(impact.value, review, {
    ...(opts.enforcePolicy !== undefined ? { enforcePolicy: opts.enforcePolicy } : {}),
  });
  return ok({ impact: impact.value, review, decision, comment });
}

export interface PrPostOptions extends PrAnalyzeOptions {
  repo: string;
  pr?: number;
  comment?: boolean;
  requestReviewers?: boolean;
  token?: string;
  apiUrl?: string;
  check?: boolean;
  headSha?: string;
  override?: DecisionOverride;
}

export interface PrPostResult extends PrAnalyzeResult {
  commentPosted: boolean;
  requestedReviewers: string[];
  requestedTeams: string[];
  checkUpdated: boolean;
}

/**
 * Analyze a PR and optionally post the comment and request reviewers.
 * Requires a token when `comment` or `requestReviewers` is set.
 */
export async function runPrIntegration(
  root: string,
  config: LoadedConfig,
  state: AnalysisState,
  opts: PrPostOptions,
): Promise<Result<PrPostResult, Error>> {
  const analyzed = analyzePr(
    root,
    config,
    state.graph,
    state.index,
    state.ownership,
    state.contexts,
    opts,
  );
  if (!analyzed.ok) return analyzed;
  const { impact, review, comment } = analyzed.value;
  let decision = analyzed.value.decision;
  if (opts.override) {
    if (opts.override.verifiedActor) {
      const policy = loadAccessPolicy(root);
      if (!policy) return err(new Error("Verified GitHub overrides require .nodenet/access.json; authorization defaults to deny."));
      const authorization = authorizeOverride(policy, opts.override.verifiedActor, opts.repo, analyzed.value.decision);
      if (!authorization.allowed) return err(new Error(`Override denied: ${authorization.reason}.`));
    }
    decision = applyDecisionOverride(decision, opts.override);
    saveOverride(root, opts.override);
  }

  const result: PrPostResult = {
    impact,
    review,
    decision,
    comment,
    commentPosted: false,
    requestedReviewers: [],
    requestedTeams: [],
    checkUpdated: false,
  };

  appendDecisionAudit(root, {
    decision,
    repository: opts.repo,
    ...(opts.pr !== undefined ? { pullRequest: opts.pr } : {}),
    ...(opts.override ? { override: opts.override } : {}),
  });
  const needsApi = opts.comment === true || opts.requestReviewers === true || opts.check === true;
  if (!needsApi) return ok(result);

  const token = opts.token ?? resolveGitHubToken();
  if (!token) {
    return err(new Error("GITHUB_TOKEN is required to post comments or request reviewers."));
  }
  const { owner, repo } = parseRepo(opts.repo);
  const client = { token, apiUrl: opts.apiUrl ?? defaultApiUrl() };

  if (opts.comment === true) {
    if (opts.pr === undefined) return err(new Error("A pull request number is required to post a comment."));
    await upsertIssueComment(client, { owner, repo, issueNumber: opts.pr, body: comment });
    result.commentPosted = true;
  }

  if (opts.requestReviewers === true) {
    if (opts.pr === undefined) return err(new Error("A pull request number is required to request reviewers."));
    // Declared reviewers only — required + authority-required. Suggested
    // (git-history inference) is never requested automatically (spec §57).
    const targets = [
      ...new Set([
        ...review.required.map((r) => r.target),
        ...review.authorityRequired.map((r) => r.target),
      ]),
    ];
    // GitHub usernames cannot contain `/`; team slugs (nested) do.
    const teamReviewers = targets.filter((t) => t.includes("/"));
    const reviewers = targets.filter((t) => !t.includes("/"));
    await requestReviewers(client, {
      owner,
      repo,
      pullNumber: opts.pr,
      reviewers,
      teamReviewers,
    });
    result.requestedReviewers = reviewers;
    result.requestedTeams = teamReviewers;
  }

  if (opts.check === true) {
    if (!opts.headSha) return err(new Error("A head SHA is required to update a GitHub check."));
    await upsertCheckRun(client, {
      owner,
      repo,
      headSha: opts.headSha,
      name: "NodeNet Governance",
      conclusion: decision.shouldFail ? "failure" : decision.outcome === "pass" ? "success" : "neutral",
      title: `${decision.outcome.toUpperCase()} · ${decision.severity} · ${decision.mode}`,
      summary: comment,
      annotations: decision.changedFiles.slice(0, 50).map((file) => ({
        path: file,
        start_line: 1,
        end_line: 1,
        annotation_level: decision.shouldFail ? "failure" : decision.outcome === "warn" ? "warning" : "notice",
        message: decision.reasons[0] ?? `NodeNet governance decision: ${decision.outcome}`,
      })),
    });
    result.checkUpdated = true;
  }

  return ok(result);
}
