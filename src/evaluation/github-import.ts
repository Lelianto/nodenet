import type { EvaluationDataset, HistoricalPullRequest } from "./types.js";

interface ImportOptions { repository: string; token: string; apiUrl?: string; since?: string; limit?: number; datasetId?: string }

export async function importGitHubHistory(options: ImportOptions, fetchImpl: typeof fetch = fetch): Promise<EvaluationDataset> {
  const [owner, repo, extra] = options.repository.split("/");
  if (!owner || !repo || extra) throw new Error("Repository must be owner/name.");
  const api = options.apiUrl ?? "https://api.github.com";
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${options.token}`, "X-GitHub-Api-Version": "2022-11-28" };
  const cases: HistoricalPullRequest[] = [];
  for (let page = 1; cases.length < limit; page += 1) {
    const response = await fetchImpl(`${api}/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`GitHub PR import failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
    const pulls = await response.json() as Array<Record<string, unknown>>;
    if (pulls.length === 0) break;
    for (const pull of pulls) {
      const updatedAt = String(pull["updated_at"] ?? "");
      if (options.since && updatedAt < options.since) continue;
      const number = Number(pull["number"]);
      const reviewsResponse = await fetchImpl(`${api}/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`, { headers });
      const reviews = reviewsResponse.ok ? await reviewsResponse.json() as Array<Record<string, unknown>> : [];
      const base = pull["base"] as Record<string, unknown>;
      const head = pull["head"] as Record<string, unknown>;
      const user = pull["user"] as Record<string, unknown> | null;
      const requested = Array.isArray(pull["requested_reviewers"]) ? pull["requested_reviewers"] as Array<Record<string, unknown>> : [];
      const record: HistoricalPullRequest = {
        schemaVersion: "1",
        provider: "github",
        repository: options.repository,
        number,
        title: String(pull["title"] ?? ""),
        url: String(pull["html_url"] ?? ""),
        baseSha: String(base?.["sha"] ?? ""),
        headSha: String(head?.["sha"] ?? ""),
        baseRef: String(base?.["ref"] ?? ""),
        headRef: String(head?.["ref"] ?? ""),
        state: pull["state"] === "open" ? "open" : "closed",
        merged: pull["merged_at"] !== null,
        requestedReviewers: requested.map((item) => String(item["login"] ?? "")).filter(Boolean),
        submittedReviewers: [...new Set(reviews.map((review) => String((review["user"] as Record<string, unknown> | null)?.["login"] ?? "")).filter(Boolean))],
        importedAt: new Date().toISOString(),
        ...(typeof user?.["id"] === "number" ? { authorGithubId: user["id"] } : {}),
        ...(typeof user?.["login"] === "string" ? { authorLogin: user["login"] } : {}),
        ...(typeof pull["merged_at"] === "string" ? { mergedAt: pull["merged_at"] } : {}),
      };
      cases.push(record);
      if (cases.length >= limit) break;
    }
    if (pulls.length < 100) break;
  }
  const now = new Date().toISOString();
  return { schemaVersion: "1", id: options.datasetId ?? `github-${owner}-${repo}-${now.slice(0, 10)}`, repository: options.repository, createdAt: now, cases };
}
