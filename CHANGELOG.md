# Changelog

All notable changes to NodeNet are documented here.

## [Unreleased]

### Added

- **`nodenet report` (Round 1 quick win)**: a deterministic, local-only
  highlights report — god nodes (highest-degree symbols with consumer counts),
  surprising connections (cross-community / far-file links), community summary,
  governance overview (contexts, authority, ownership/authority coverage) and
  suggested questions the graph is positioned to answer. Output as markdown or
  `--json`; also exposed as a `report` MCP tool. No LLM, no network.

## [0.3.0] — 2026-08-07

### Added

- **Interactive visualization (Phase 8)**: `nodenet graph` now generates a
  self-contained interactive HTML viewer — force-directed layout with
  community clusters (label propagation), pan/zoom, hover-highlight, click to
  inspect a node, search, and layer filters. Layout is deterministic and
  computed at build time; zero new dependencies. A static **SVG export**
  (`nodenet graph -f svg`) renders the same layout as an embeddable image.
- **Example project**: `examples/payments-demo` — a checkout → payment demo
  with living context, ownership, authority, a pre-built `graph.html`, and
  `./demo.sh` covering query/trace/context/health plus a PR-style
  `impact`/`reviewers` run.
- **Docs**: ADR 006 (interactive visualization), README example section.

### Fixed

- **Ownership source priority was inverted** (`src/ownership/resolver.ts`):
  the resolver scored `priority * 100 + confidence` and took the largest
  value, which ranked CODEOWNERS above explicit `.nodenet/ownership.json` and
  LCDD context ownership. Now LCDD context > NodeNet explicit > CODEOWNERS >
  git-history, as specified (§10).
- **`trace` display** printed each edge's source instead of its destination,
  producing a duplicated hop; the full explainable chain is now shown.

## [0.2.0] — 2026-08-07

### Added

- **GitHub integration (Phase 6)**: `nodenet github pr` — analyzes a PR diff,
  builds a deterministic impact + review comment, and can post it and request
  declared reviewers via the GitHub REST API (global fetch, zero new deps).
  Least privilege (`contents: read`, `pull-requests: write`); token never
  logged.
- **AI integration (Phase 7)**: `nodenet mcp` — a dependency-free MCP server
  over stdio exposing `query`, `related`, `trace`, `context` (MSC bundle),
  `explain`, `governed_by`, `owner`, `impact`, `reviewers`, `health`, `graph`.
  Tool arguments are Valibot-validated; tool failures return MCP `isError`
  instead of crashing the server.
- **Docs**: ADR 004 (GitHub integration), ADR 005 (MCP server design),
  integration sections in README, updated threat model + SECURITY.

## [0.1.0] — 2026-08-07

First reference implementation.

### Added

- **Core graph**: discriminated `GraphNode` union (code/context/actor layers),
  typed `GraphEdge` with relation validation, immutable `Graph` with
  `GraphPatch` change sets, cycle-safe BFS traversal.
- **Code analysis**: TypeScript Compiler API parser (TS/TSX/JS/JSX) producing
  functions, methods, classes, interfaces, type aliases, enums, variables,
  React components/hooks, imports/exports, calls, references, heritage, tests.
- **Living Context (LCDD-aligned)**: schema with provenance + governance
  classification, validated lifecycle (DRAFT → CANDIDATE → APPROVED → ACTIVE →
  NEEDS_REVIEW / DEPRECATED → ARCHIVED), freshness decay.
- **Ownership**: source-ranked resolution (LCDD > NodeNet > CODEOWNERS > git
  history), confidence levels; git history produces suggestions only.
- **Authority**: INFORMATIONAL → MANDATORY with LCDD classification mapping.
- **Change graph**: safe git diff (argument arrays), symbol-level diff,
  impact analysis, ownership-boundary detection.
- **Review governance**: severity (LOW/MEDIUM/HIGH/CRITICAL), reviewer
  resolution (suggested / required / authorityRequired) with dedup.
- **Health**: metrics derived from graph state (stale, orphan, coverage, ...).
- **AI context**: Minimum Sufficient Context bundle with provenance-marked
  sections and secret scanning.
- **CLI**: `init build update watch query related trace context explain owner
  governed-by impact reviewers conflicts health graph doctor` + `--json`.
- **Security**: SafeRelativePath, symlink defense, resource limits, secret
  detection, audit log, suppressions.
- **Docs**: README, ARCHITECTURE, SECURITY, threat model, ADR 001-003, concepts.
- **Tests**: 50 unit/integration/security/property tests across 8 fixtures,
  including the cross-team MVP scenario.
