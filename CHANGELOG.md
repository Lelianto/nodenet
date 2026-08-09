# Changelog

All notable changes to NodeNet are documented here.

## [Unreleased]

### Added

- `nodenet open`: one-command loopback graph server with automatic browser
  launch, repository watching, SSE hot reload, safe error retention, and
  optional change-decision overlay.
- Optional dependency-free 3D governance-map view with perspective depth,
  drag rotation, Shift+drag panning, and 2D/3D switching.
- Historical Decision Lab: authenticated GitHub PR/review metadata import,
  isolated base/head replay without repository-code execution, blind local
  labeling UI, evaluation reports, and configurable CI quality gates.
- Verified override foundation: numeric GitHub actor derivation, explicit
  claimed/verified assurance, default-deny repository/Context-scoped RBAC, and
  Ed25519 signed-override generation/verification APIs.

- Decision-quality benchmark datasets and metrics for reviewer precision and
  recall, false blocks, missed hardened impacts, outcome accuracy, and p50/p95
  latency.
- Deterministic decision identifiers with NodeNet/LCDD versions, append-only
  decision audit events, and exact-ID emergency overrides requiring actor,
  reason, and future expiry.
- Idempotent GitHub Check Runs with annotations, transient-error retry,
  `merge_group` support, and observe/warn/enforce conclusions.
- `nodenet bootstrap [--github]` and an expanded `nodenet doctor [--json]`
  readiness report for sub-15-minute repository activation.
- A four-week design-partner playbook and explicit paid-pilot release gate for
  organization/multi-repository product work.

## [0.4.0] — 2026-08-08

### Added

- **LCDD 0.6.0 canonical registry support**: exact `@lcdd/core@0.6.0`
  integration, `.lcdd/contexts/**/*.yaml` loading, lifecycle/enforcement
  mapping, provenance retention, legacy context migration, and compatibility
  tests.
- **Governance Decision v1**: stable machine-readable `pass` / `warn` /
  `block` outcomes with observe/warn/enforce rollout modes, required approvals,
  ownership boundaries, and GitHub required-check workflow support.
- **Graphify-style Governance Map**: Architecture, Governance, and Change
  modes; community colors, semantic shapes, authority rings, change halos,
  evidence inspector, filters, search, isolation, pan/zoom, and decision
  overlay via `nodenet graph --change`.
- **Ten-language parsing** with a public tiered adapter registry. Full:
  TypeScript, JavaScript, Python, Go, Java, C#, PHP. Basic: Rust, Ruby,
  Kotlin. `nodenet languages [--json]` exposes the exact capability contract.
- **Deterministic artifact ingestion** for ADR Markdown, OpenAPI operations,
  SQL tables, and Terraform resources.
- **Incremental parse cache**: unchanged files reuse validated local parse
  results during graph rebuilds.
- **Multi-change collision triage**: `nodenet changes --base <ref> --refs ...`
  identifies shared files, graph nodes, LCDD contexts, and ownership boundaries
  across local branches.
- **Shared HTTP MCP transport**: `nodenet serve`, loopback-first with optional
  bearer authentication and bounded request bodies.
- **Query-first agent installers** for Codex, Claude, Cursor, and generic Agent
  Skills using reversible marked instruction blocks.
- **Evidence taxonomy**: `EXTRACTED`, `DECLARED`, `INFERRED`, `AMBIGUOUS`, and
  `OBSERVED` relationship classifications.
- **`nodenet report`**: a deterministic, local-only
  highlights report — god nodes (highest-degree symbols with consumer counts),
  surprising connections (cross-community / far-file links), community summary,
  governance overview (contexts, authority, ownership/authority coverage) and
  suggested questions the graph is positioned to answer. Output as markdown or
  `--json`; also exposed as a `report` MCP tool. No LLM, no network.
- **Language documentation and diagram** included in the npm package, plus a
  per-language declaration/import contract test suite.

### Changed

- Minimum Node.js version is now 20; CI verifies Node 20 and 22.
- The payments example now uses canonical LCDD YAML instead of the deprecated
  `.nodenet/context.json` format.
- The public graph model now persists method visibility and governance metadata.

### Fixed

- Persisted graphs now correctly restore every concrete living-context node
  kind and its LCDD governance metadata.
- Visualization fits nodes to the canvas and folds filesystem singleton
  communities into their domain cluster.

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
