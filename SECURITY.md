# NodeNet Security

NodeNet treats **everything from the repository as untrusted input** (spec §38):
source code, comments, configuration, git data, PR content.

## Guarantees

- **No code execution.** NodeNet never executes repository code, scripts,
  config files, or shell commands from repository content (spec §21, §43).
  Configuration is `nodenet.config.json` (data), never `.js`.
- **No shell interpolation.** Git is invoked with argument arrays
  (`spawn("git", [args...])`); refs are validated against
  `/^[A-Za-z0-9][A-Za-z0-9._\-\/]*$/` and may not contain `..` (spec §42).
- **Path containment.** All repository reads go through `SafeRelativePath` +
  `resolveSafe`, which re-checks containment *after* realpath resolution so
  symlinks cannot escape the repository root (spec §39).
- **Resource limits.** Configurable max file size, file count, AST nodes, graph
  nodes/edges, traversal depth/nodes, query results, context output. Violations
  fail safely with warnings or typed errors — never unbounded memory (spec §40).
- **Secret protection.** Secret-like paths (`.env*`, `*.pem`, `*.key`,
  `credentials.*`, `secrets.*`, ...) are never scanned; generated AI context is
  scanned for secret patterns before output (spec §45).
- **No prompt-injection execution.** Source comments are evidence, never
  instructions. AI context output marks sections by source and authority
  (spec §46, §47).
- **Least-privilege GitHub integration** (`nodenet github pr`). Requests only
  the permissions it needs: `contents: read`, `pull-requests: write` (spec
  §56). Auth comes from `GITHUB_TOKEN` / `--token`; the token is never
  logged, and requests go to the REST API with JSON bodies only — never
  shell-concatenated. Review requests include *declared* reviewers only
  (required + authority-required); git-history suggestions are never sent
  automatically (spec §57).

## Plugin policy

Plugins (when introduced) are **trusted dependencies** that receive local code
execution privileges. NodeNet will never auto-load plugins discovered inside
arbitrary repositories. This is documented prominently (spec §44).

## Audit

Governance actions (context transitions, proposals, ownership changes, review
requests, conflict detection) are appended to `.nodenet/audit.jsonl`. The audit
never logs secrets, tokens, credentials, or full source files (spec §48).

## Reporting

See `docs/security/threat-model.md` for the full threat model. For security
issues, open a GitHub issue with the `security` label.

## Related docs

- [docs/security/threat-model.md](docs/security/threat-model.md) — full threat matrix
- [docs/adr/002-runtime-validation.md](docs/adr/002-runtime-validation.md) — why
  all external input is runtime-validated
- [docs/](docs/) — documentation index
