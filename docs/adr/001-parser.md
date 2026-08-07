# ADR 001: AST parser choice

- Status: accepted
- Date: 2026-08-07

## Context

NodeNet must deterministically analyze TypeScript/TSX/JavaScript/JSX (spec §50)
to extract symbols, imports/exports, references, calls and heritage. Candidates:
TypeScript Compiler API, ts-morph, SWC, tree-sitter.

## Decision

**TypeScript Compiler API** (already a dependency for nothing else — it *is* the
language itself).

## Rationale

| Criterion | TS Compiler API | tree-sitter | SWC | ts-morph |
| --- | --- | --- | --- | --- |
| Native TS/JSX support | ✅ first-class | ✅ grammar | ✅ | ✅ (wraps TS API) |
| Deterministic, dependency-light | ✅ | requires native bindings | ✅ | ✅ |
| Identifier/reference collection | ✅ full AST | ✅ | partial | ✅ |
| Module resolution depth | ✅ strong | ❌ | partial | ✅ |
| Zero extra native deps | ✅ | ❌ | ✅ (WASM/native) | ✅ |

The TypeScript Compiler API provides the strongest type/module resolution for
TS/JS at zero extra dependency cost, is fully deterministic, and parses TSX/JSX
natively. tree-sitter was seriously evaluated (per spec §49) but adds native
bindings without adding module-resolution power for our v0.1 scope.

## Trade-off (documented)

We deliberately do **not** run the full type checker: each file is parsed
independently and cross-file symbol resolution uses an explicit import/export
table. This keeps analysis fast, deterministic and incremental (spec §51), at
the cost of not resolving namespaced/aliased calls (`ns.fn()`, path aliases).
A checker-backed mode can be layered later without changing the graph model.

## Consequences

- Parser lives in `src/parser/typescript.ts`, isolated behind `ParsedFile` so
  additional language adapters can be added later (spec §50).
- Parsing never throws; syntax errors degrade to warnings with limits enforced
  (`maxAstNodesPerFile`).

## See also

- [../README.md](../README.md) — documentation index
- [002-runtime-validation.md](002-runtime-validation.md) — how parsed and
  persisted data is validated at runtime
- [003-graph-storage.md](003-graph-storage.md) — where the parsed graph is stored
- [../../ARCHITECTURE.md](../../ARCHITECTURE.md) — the two-phase build that makes
  cross-file resolution deterministic
