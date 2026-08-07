/**
 * GitHub REST API client (NodeNet spec §56).
 *
 * Minimal fetch-based client (Node ≥ 18 global fetch). Auth comes from a
 * token (GITHUB_TOKEN / GH_TOKEN). Requests are scoped to the least
 * privilege needed by the GitHub Action: `contents: read` for analysis and
 * `pull-requests: write` for comments and review requests. Tokens are never
 * logged. Errors carry the HTTP status and response body for diagnosis.
 */

export interface GitHubClientConfig {
  /** Token for GitHub API requests. Never logged. */
  token: string;
  /** Base URL, defaults to https://api.github.com (override for GHES). */
  apiUrl: string;
}

export interface GitHubComment {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}

export interface GitHubReviewRequest {
  owner: string;
  repo: string;
  pullNumber: number;
  /** GitHub user handles. */
  reviewers: string[];
  /** GitHub team slugs (may contain `/` for nested teams). */
  teamReviewers: string[];
}

export interface GitHubApiResponse {
  status: number;
  body: string;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

const API_VERSION = "2022-11-28";

/** The env var used by GitHub Actions; falls back to a plain token. */
export function resolveGitHubToken(env: Record<string, string | undefined> = process.env): string | undefined {
  return env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
}

export function defaultApiUrl(env: Record<string, string | undefined> = process.env): string {
  return env["GITHUB_API_URL"] ?? "https://api.github.com";
}

/** Parse an `owner/repo` string into { owner, repo }. */
export function parseRepo(repo: string): { owner: string; repo: string } {
  const match = /^([^/]+)\/([^/]+)$/.exec(repo);
  if (!match) throw new Error(`Invalid repository "${repo}" — expected "owner/repo".`);
  return { owner: match[1] ?? "", repo: match[2] ?? "" };
}

/** Resolve the PR number from a flag or a GitHub Actions env context. */
export function resolvePullNumber(value: string | undefined, env: Record<string, string | undefined> = process.env): number {
  if (value !== undefined) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid pull request number: ${value}`);
    return n;
  }
  const fromEnv = env["GITHUB_PR_NUMBER"];
  if (fromEnv) {
    const n = Number(fromEnv);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const ref = env["GITHUB_REF"];
  if (ref) {
    const match = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(ref);
    if (match) {
      const n = Number(match[1]);
      if (Number.isInteger(n)) return n;
    }
  }
  throw new Error("Pull request number not provided. Pass --pr or set GITHUB_PR_NUMBER / GITHUB_REF.");
}

function request(
  client: GitHubClientConfig,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubApiResponse> {
  const init: RequestInit = {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      ...(client.token ? { Authorization: `Bearer ${client.token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetchImpl(`${client.apiUrl}${path}`, init).then(async (res) => ({
    status: res.status,
    body: await res.text(),
  }));
}

async function assertOk(response: GitHubApiResponse, action: string): Promise<void> {
  if (response.status >= 200 && response.status < 300) return;
  const detail = response.body.length > 0 ? `: ${response.body.slice(0, 500)}` : "";
  throw new GitHubApiError(`GitHub API ${action} failed (HTTP ${response.status})${detail}`, response.status, response.body);
}

/** Post an issue/PR comment. */
export async function postIssueComment(
  client: GitHubClientConfig,
  input: GitHubComment,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubApiResponse> {
  const response = await request(
    client,
    "POST",
    `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`,
    { body: input.body },
    fetchImpl,
  );
  await assertOk(response, "comment");
  return response;
}

/** Request reviewers on a pull request (users and/or teams). */
export async function requestReviewers(
  client: GitHubClientConfig,
  input: GitHubReviewRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubApiResponse> {
  const payload: Record<string, string[]> = {};
  if (input.reviewers.length > 0) payload["reviewers"] = [...new Set(input.reviewers)];
  if (input.teamReviewers.length > 0) payload["team_reviewers"] = [...new Set(input.teamReviewers)];
  if (Object.keys(payload).length === 0) {
    throw new Error("No reviewers to request.");
  }
  const response = await request(
    client,
    "POST",
    `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/requested_reviewers`,
    payload,
    fetchImpl,
  );
  await assertOk(response, "request reviewers");
  return response;
}
