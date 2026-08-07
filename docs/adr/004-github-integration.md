# ADR 004: GitHub pull-request integration

- Status: accepted
- Date: 2026-08-07

## Context

NodeNet must participate in pull-request workflows so its deterministic
impact analysis and reviewer resolution run where decisions are made (spec
§56, §57). Candidates: a GitHub App, a GitHub Action that shells out to the
CLI, or an in-process REST client.

## Decision

A CLI command **`nodenet github pr`** that runs inside a GitHub Actions
checkout. It reuses the existing local impact analysis (`git diff <base>
HEAD`, arg-array git only) and posts results over the GitHub REST API using
Node's global `fetch` — no new runtime dependencies.

- Comment: `POST /repos/{owner}/{repo}/issues/{n}/comments`
- Review requests: `POST /repos/{owner}/{repo}/pulls/{n}/requested_reviewers`
- Auth: `GITHUB_TOKEN` (or `--token`), never logged.
- Least privilege (spec §56): `contents: read`, `pull-requests: write`.

## Rationale

| Criterion | CLI + REST fetch | GitHub App | Action-only (shell) |
| --- | --- | --- | --- |
| Zero new deps | ✅ | ❌ webhook + SDK | ✅ |
| Reuses `impact`/`reviewers` | ✅ | partial | ✅ (duplicated) |
| Testable without a GitHub account | ✅ mocked fetch | ❌ | ❌ |
| Explains its results | ✅ full comment | partial | partial |

Review requests only ever include **declared** reviewers (required +
authority-required) — git-history inference is never requested automatically
(spec §57).

## Consequences

- Requires a git checkout of the PR head and a known base ref
  (`GITHUB_BASE_REF` / `--base`).
- Target names are sent as GitHub handles; names containing `/` are treated
  as nested team slugs. Unknown handles surface as API errors, reported
  without crashing the run.
- GitHub Enterprise Server is supported via `GITHUB_API_URL`.
