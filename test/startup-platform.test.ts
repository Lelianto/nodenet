import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { withLiveReloadClient } from "../src/visualization/dev-server.js";
import { importGitHubHistory } from "../src/evaluation/github-import.js";
import { renderLabelApp, validateEvaluationLabel } from "../src/evaluation/label-server.js";
import { authorizeOverride, type AccessPolicy } from "../src/identity/rbac.js";
import { resolveGitHubIdentity } from "../src/identity/identity.js";
import { signOverride, verifySignedOverride } from "../src/identity/signed-override.js";
import type { EvaluationDataset } from "../src/evaluation/types.js";
import { replayDataset } from "../src/evaluation/replay.js";
import type { GovernanceDecision } from "../src/governance/decision.js";
import { makeGitRepo } from "./helpers.js";

function dataset(): EvaluationDataset {
  return { schemaVersion: "1", id: "pilot", repository: "acme/payments", createdAt: "2026-08-09T00:00:00Z", cases: [{ schemaVersion: "1", provider: "github", repository: "acme/payments", number: 7, title: "Protect settlement", url: "https://github.com/acme/payments/pull/7", baseSha: "a".repeat(40), headSha: "b".repeat(40), baseRef: "main", headRef: "feature", state: "closed", merged: true, requestedReviewers: ["security"], submittedReviewers: ["security"], importedAt: "2026-08-09T00:00:00Z" }] };
}

describe("live graph and evaluation UI", () => {
  it("serves the graph with a hot-reload client on loopback", async () => {
    const html = withLiveReloadClient("<!doctype html><body>graph</body>");
    expect(html).toContain("graph");
    expect(html).toContain("EventSource");
  });

  it("serves blind labeling and persists a validated label", async () => {
    const html = renderLabelApp(dataset(), undefined, []);
    expect(html).toContain("NodeNet Decision Lab");
    expect(html).toContain("hidden to reduce labeling bias");
    const label = validateEvaluationLabel({ pullRequest: 7, expectedOutcome: "block", expectedReviewers: ["security"], hardenedImpactExpected: true, feedbackClass: "correct", confidence: "high", notes: "reviewed", labeler: "alice" }, dataset());
    expect(label).toMatchObject({ pullRequest: 7, expectedOutcome: "block", labeler: "alice" });
  });
});

describe("historical import and verified overrides", () => {
  it("imports GitHub PR and review metadata", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ number: 7, title: "PR", html_url: "https://github/pr/7", updated_at: "2026-08-09", state: "closed", merged_at: "2026-08-09", base: { sha: "a".repeat(40), ref: "main" }, head: { sha: "b".repeat(40), ref: "feature" }, user: { id: 12, login: "alice" }, requested_reviewers: [{ login: "security" }] }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ user: { login: "security" } }]), { status: 200 }));
    const result = await importGitHubHistory({ repository: "acme/payments", token: "secret", limit: 1, datasetId: "pilot" }, fetchMock as unknown as typeof fetch);
    expect(result.cases[0]).toMatchObject({ number: 7, authorGithubId: 12, requestedReviewers: ["security"], submittedReviewers: ["security"] });
  });

  it("replays an exact historical base/head pair in an isolated worktree", () => {
    const root = makeGitRepo("basic-typescript", (dir) => fs.appendFileSync(path.join(dir, "src/math.ts"), "\nexport const replayed = true;\n"));
    try {
      const baseSha = execSync("git rev-parse main", { cwd: root, encoding: "utf8" }).trim();
      const headSha = execSync("git rev-parse feature", { cwd: root, encoding: "utf8" }).trim();
      const input = dataset();
      input.cases[0] = { ...input.cases[0]!, baseSha, headSha };
      const run = replayDataset(root, input);
      expect(run.cases).toHaveLength(1);
      expect(run.cases[0]?.error).toBeUndefined();
      expect(run.cases[0]?.decision?.changedFiles).toContain("src/math.ts");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives a numeric GitHub Actions actor and authorizes only scoped override approvers", async () => {
    const identity = await resolveGitHubIdentity(undefined, { GITHUB_ACTIONS: "true", GITHUB_ACTOR_ID: "123", GITHUB_ACTOR: "alice" });
    expect(identity).toMatchObject({ providerUserId: 123, login: "alice", assurance: "github-actions" });
    const policy: AccessPolicy = { schemaVersion: "1", bindings: [{ githubUserId: 123, role: "override-approver", repositories: ["acme/*"], contextPatterns: ["SEC-*"] }] };
    const decision = { affectedContexts: [{ id: "SEC-009" }] } as GovernanceDecision;
    expect(authorizeOverride(policy, identity!, "acme/payments", decision).allowed).toBe(true);
    expect(authorizeOverride(policy, identity!, "other/payments", decision).allowed).toBe(false);
  });

  it("signs an override bound to decision, commit and repository", () => {
    const keys = generateKeyPairSync("ed25519");
    const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const payload = { schemaVersion: "1" as const, overrideId: "ovr-1", decisionId: "dec-1", commitSha: "a".repeat(40), repository: "acme/payments", actorGithubId: 123, reason: "emergency remediation", issuedAt: "2026-08-09T00:00:00Z", expiresAt: "2026-08-10T00:00:00Z", nonce: "nonce-1", keyId: "key-1" };
    const signed = signOverride(payload, privatePem);
    expect(verifySignedOverride(signed, publicPem, { decisionId: "dec-1", commitSha: "a".repeat(40), repository: "acme/payments" }, new Date("2026-08-09T12:00:00Z")).valid).toBe(true);
    expect(verifySignedOverride(signed, publicPem, { decisionId: "other", commitSha: "a".repeat(40), repository: "acme/payments" }).valid).toBe(false);
  });
});
