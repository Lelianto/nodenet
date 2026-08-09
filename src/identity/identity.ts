export type IdentityAssurance = "claimed" | "github-actions" | "github-user-token";

export interface VerifiedIdentity {
  provider: "github";
  providerUserId: number;
  login: string;
  assurance: Exclude<IdentityAssurance, "claimed">;
  verifiedAt: string;
}

export async function resolveGitHubIdentity(
  token: string | undefined,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedIdentity | undefined> {
  if (env["GITHUB_ACTIONS"] === "true") {
    const id = Number(env["GITHUB_ACTOR_ID"]);
    const login = env["GITHUB_ACTOR"];
    if (Number.isInteger(id) && id > 0 && login) {
      return { provider: "github", providerUserId: id, login, assurance: "github-actions", verifiedAt: new Date().toISOString() };
    }
  }
  if (!token) return undefined;
  const response = await fetchImpl(`${env["GITHUB_API_URL"] ?? "https://api.github.com"}/user`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`Cannot verify GitHub identity (HTTP ${response.status}).`);
  const user = await response.json() as Record<string, unknown>;
  if (typeof user["id"] !== "number" || typeof user["login"] !== "string") throw new Error("GitHub identity response is incomplete.");
  return { provider: "github", providerUserId: user["id"], login: user["login"], assurance: "github-user-token", verifiedAt: new Date().toISOString() };
}
