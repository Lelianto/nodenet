# Changelog

All notable changes to NodeNet are documented here.

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
