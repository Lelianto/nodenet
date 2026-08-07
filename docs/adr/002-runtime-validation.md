# ADR 002: Runtime validation library

- Status: accepted
- Date: 2026-08-07

## Context

Compile-time types are not enough (spec §34): configuration, graph persistence,
living context files, CODEOWNERS-derived data, git data, and (future) GitHub
responses are external input and must be runtime-validated. Candidates: Zod,
Valibot.

## Decision

**Valibot** (`^1.0.0`).

## Rationale

| Criterion | Valibot | Zod |
| --- | --- | --- |
| Bundle size | tiny (tree-shaken, ~1 kB for our schemas) | larger |
| Type inference | `v.InferOutput<T>` full TS integration | equivalent |
| API ergonomics | similar object/array/picklist primitives | similar |
| Strict-mode support | ✅ | ✅ |

Valibot satisfies the requirements at a fraction of the size — aligned with
NodeNet's "lightweight" product principle (spec §1).

## Scope

Runtime validation is applied at every external boundary:

- `nodenet.config.json` → `ConfigSchema`
- living context artifacts → `ContextRecordSchema` (LCDD-shaped input is
  normalized first)
- persisted graph snapshots → structural validation + edge-pair re-validation
  via `Graph.fromSnapshot`
- ownership records / suppressions / audit entries → structural checks

## Consequences

- Invalid external data is reported and skipped (with warnings) or returns a
  typed `MalformedConfigError` / `InvalidContextError` — never silently coerced.
- `as any` is never used to bypass validation.

## See also

- [../README.md](../README.md) — documentation index
- [001-parser.md](001-parser.md) — the parser whose output this validates
- [003-graph-storage.md](003-graph-storage.md) — the persisted data this validates
- [../../SECURITY.md](../../SECURITY.md) — why untrusted input is validated
  (spec §38)
