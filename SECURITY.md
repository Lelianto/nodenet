# NodeNet Security Policy

NodeNet treats repository content and integration input as untrusted. This
document explains the supported release line, how to report a vulnerability,
and the security boundaries contributors and operators should preserve.

## Supported versions

Security fixes are applied to the latest published release. Older releases may
not receive backports. Before reporting or reproducing an issue, verify it
against the latest version when doing so is safe.

| Version | Supported |
| --- | --- |
| Latest published release | Yes |
| Older releases | No guaranteed fixes |
| Unreleased `main` branch | Best effort; not a stable release |

## Reporting a vulnerability

Do not open a public issue, discussion, or pull request for a suspected
vulnerability. Use GitHub's private vulnerability-reporting flow:

[Report a vulnerability privately](https://github.com/Lelianto/nodenet/security/advisories/new)

Include enough information to reproduce and assess the issue without exposing
unrelated sensitive data:

- affected NodeNet version or commit;
- operating system and Node.js version;
- affected command, API, MCP transport, or integration;
- minimal reproduction steps or a small sanitized fixture;
- expected and observed behavior;
- security impact and required attacker capabilities;
- any known workaround.

Do not include real credentials, proprietary source code, customer data, or a
live exploit against systems you do not own. If the private reporting form is
unavailable, open a public issue containing no vulnerability details and ask a
maintainer for a private contact channel.

Maintainers will acknowledge the report, investigate impact, coordinate a fix
and disclosure when warranted, and credit reporters who want attribution.
Please allow a reasonable remediation window before public disclosure.

## Security boundaries and controls

- **No repository-code execution.** Analysis parses repository content; it does
  not execute repository source, scripts, or JavaScript configuration. NodeNet
  configuration is JSON data and is runtime-validated.
- **No shell interpolation.** Git and other child processes are invoked with
  argument arrays. Git refs are validated before use.
- **Path containment.** Repository reads use safe relative paths and re-check
  containment after realpath resolution so symlinks cannot escape the root.
- **Bounded work.** File, AST, graph, traversal, query, request-body, and output
  limits prevent unbounded processing. Violations fail safely with warnings or
  typed errors.
- **Secret protection.** Secret-like files are excluded from scanning and AI
  context output is checked for common secret patterns. Audit records exclude
  source contents and credentials.
- **Prompt-injection resistance.** Source comments and documentation are
  evidence, never executable instructions. Generated context retains source
  and authority provenance.
- **Runtime validation.** Configuration, persisted snapshots, MCP arguments,
  remote responses, and other external data are validated at their trust
  boundaries.
- **Scoped shared access.** The experimental HTTP JSON-RPC bridge defaults to
  loopback, supports bearer authentication and per-token scopes, applies rate
  limits, uses immutable state snapshots, and records security-relevant audit
  events. It is not an internet-facing hosted service or MCP Streamable HTTP
  implementation.
- **Least-privilege GitHub access.** Read-only analysis does not require a
  token. Check Runs, comments, and reviewer requests require only the relevant
  repository permissions; tokens are not logged. Git-history suggestions are
  never requested as reviewers automatically.

These controls reduce risk but are not a guarantee that NodeNet is free of
vulnerabilities. Operators remain responsible for access control, host
security, dependency updates, token scope, and safe CI configuration.

## Deployment guidance

- Prefer the stdio MCP server (`nodenet mcp`) for a single local client.
- Keep `nodenet serve` bound to loopback. If remote access is unavoidable, put
  it behind an authenticated, TLS-terminating proxy and use a dedicated,
  least-privilege token with only the required scopes.
- Do not expose generated `.nodenet/` state, audit logs, evaluation datasets,
  or graph views publicly without reviewing them for repository metadata.
- In CI, pin trusted workflow actions, grant the minimum GitHub permissions,
  and do not run pull-request-controlled scripts with privileged secrets.
- Run `nodenet audit-verify` before relying on the local audit chain. The chain
  is tamper-evident, not an externally anchored or immutable ledger.

Operational details for the shared bridge are in
[docs/mcp-operations.md](docs/mcp-operations.md).

## Plugin policy

Plugins are trusted dependencies with local code-execution privileges. NodeNet
does not auto-load plugins discovered inside arbitrary repositories. Review and
pin any plugin before granting it repository or credential access.

## Scope notes

The full threat model, including assumptions and out-of-scope risks, lives in
[docs/security/threat-model.md](docs/security/threat-model.md). In particular,
local JSON state is validated but not encrypted, and a process that already
controls the host or NodeNet installation is outside the repository-input
threat boundary.

## Related documentation

- [Threat model](docs/security/threat-model.md)
- [Runtime-validation ADR](docs/adr/002-runtime-validation.md)
- [MCP design ADR](docs/adr/005-mcp-server.md)
- [MCP operations](docs/mcp-operations.md)
- [Verified overrides](docs/verified-overrides.md)
- [Contributing guide](CONTRIBUTING.md)
