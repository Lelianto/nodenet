# NodeNet Documentation

This directory is the hub for all NodeNet documentation. Start with the
[README](../README.md), then use the index below to go deep on any topic.

## Reading order

| Step | Topic | Document |
| --- | --- | --- |
| 1 | What NodeNet is and how to use it | [README](../README.md) |
| 2 | How the system is structured | [ARCHITECTURE](../ARCHITECTURE.md) |
| 3 | The unified graph — nodes, edges, operations | [concepts/graph.md](concepts/graph.md) |
| 4 | Living context and its lifecycle | [concepts/living-context.md](concepts/living-context.md) |
| 5 | Ownership resolution and ranking | [concepts/ownership.md](concepts/ownership.md) |
| 6 | Authority levels and AI limits | [concepts/authority.md](concepts/authority.md) |
| 7 | Change impact analysis | [concepts/change-impact.md](concepts/change-impact.md) |
| 8 | Review governance | [concepts/review-governance.md](concepts/review-governance.md) |
| 9 | Security model | [security/threat-model.md](security/threat-model.md) |
| 10 | Supported languages and usage | [languages.md](languages.md) |

## Concepts

Core mental model documents.

- [graph.md](concepts/graph.md) — node kinds, edge relations, and the operations
  (`query`, `related`, `trace`, `explain`) that traverse the graph.
- [living-context.md](concepts/living-context.md) — the LCDD context artifact,
  its lifecycle transitions, and how conflicting changes are handled.
- [ownership.md](concepts/ownership.md) — how ownership is resolved, ranked, and
  why it differs from context authority.
- [authority.md](concepts/authority.md) — authority levels and what AI agents may
  and may not do automatically.
- [change-impact.md](concepts/change-impact.md) — how a git diff becomes an
  explainable impact report.
- [review-governance.md](concepts/review-governance.md) — severity policy and how
  reviewers are resolved with deduplicated, explainable reasons.
- [languages.md](languages.md) — ten-language capability matrix, examples,
  tests, and CLI/MCP/API/visualization access paths.

## Architecture decision records

Why NodeNet was built the way it was.

- [adr/001-parser.md](adr/001-parser.md) — TypeScript Compiler API for analysis.
- [adr/002-runtime-validation.md](adr/002-runtime-validation.md) — Valibot at every
  external boundary.
- [adr/003-graph-storage.md](adr/003-graph-storage.md) — local JSON files in
  `.nodenet/`.
- [adr/004-github-integration.md](adr/004-github-integration.md) — GitHub
  pull-request integration via REST + global fetch (zero new deps).
- [adr/005-mcp-server.md](adr/005-mcp-server.md) — dependency-free MCP server
  over stdio.
- [adr/006-visualization.md](adr/006-visualization.md) — deterministic
  community layout + interactive canvas viewer.

## Integrations

- **GitHub** — `nodenet github pr` analyzes a PR and can post the impact
  comment and request reviewers. See [adr/004-github-integration.md](adr/004-github-integration.md).
- **AI assistants (MCP)** — `nodenet mcp` exposes the graph, living context
  and review resolution as MCP tools. See [adr/005-mcp-server.md](adr/005-mcp-server.md).

## Security

- [security/threat-model.md](security/threat-model.md) — trust boundaries and the
  full threat matrix.
- [SECURITY.md](../SECURITY.md) — security guarantees and how to report issues.

## Project docs

- [CONTRIBUTING.md](../CONTRIBUTING.md) — development workflow and conventions.
- [CHANGELOG.md](../CHANGELOG.md) — release history.
- [roadmap.md](roadmap.md) — the prioritized development plan (gap audit and
  rounds).
- [package.json](../package.json) — scripts, dependencies, metadata.

---

When you add a new concept, ADR, or security note, link it from this index so
the documentation stays navigable.
