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
  postIssueComment,
  requestReviewers,
} from "./client.js";

export interface PrAnalyzeOptions {
  base?: string;
  authorTeam?: string;
  enforcePolicy?: boolean;
}

export interface PrAnalyzeResult {
  impact: ImpactReport;
  review: ReviewResolution;
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
  const comment = buildPrComment(impact.value, review, {
    ...(opts.enforcePolicy !== undefined ? { enforcePolicy: opts.enforcePolicy } : {}),
  });
  return ok({ impact: impact.value, review, comment });
}

export interface PrPostOptions extends PrAnalyzeOptions {
  repo: string;
  pr: number;
  comment?: boolean;
  requestReviewers?: boolean;
  token?: string;
  apiUrl?: string;
}

export interface PrPostResult extends PrAnalyzeResult {
  commentPosted: boolean;
  requestedReviewers: string[];
  requestedTeams: string[];
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

  const result: PrPostResult = {
    impact,
    review,
    comment,
    commentPosted: false,
    requestedReviewers: [],
    requestedTeams: [],
  };

  const needsApi = opts.comment === true || opts.requestReviewers === true;
  if (!needsApi) return ok(result);

  const token = opts.token ?? resolveGitHubToken();
  if (!token) {
    return err(new Error("GITHUB_TOKEN is required to post comments or request reviewers."));
  }
  const { owner, repo } = parseRepo(opts.repo);
  const client = { token, apiUrl: opts.apiUrl ?? defaultApiUrl() };

  if (opts.comment === true) {
    await postIssueComment(client, { owner, repo, issueNumber: opts.pr, body: comment });
    result.commentPosted = true;
  }

  if (opts.requestReviewers === true) {
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

  return ok(result);
}
