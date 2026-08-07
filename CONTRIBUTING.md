# Contributing to NodeNet

Thanks for contributing! NodeNet follows the principles of Living Context
Driven Development: context is a first-class, versioned, governed artifact.

## Development

```bash
npm install
npm run typecheck    # strict TS, noUncheckedIndexedAccess, exactOptionalPropertyTypes
npm test             # vitest: unit, integration, security, property-based
npm run build        # compile to dist/
```

## What counts as done

Per spec §73, a feature is complete when: implementation exists, types are
strict, runtime validation exists, security implications are considered, tests
pass, documentation exists, error cases are handled, and output is explainable.

No placeholders. No fake data. No fake benchmarks.

## Conventions

- TypeScript strict mode; prefer `unknown` + narrowing over `any`.
- Branded types for identifiers (`NodeId`, `ContextId`, `TeamId`, ...).
- Discriminated unions for graph nodes; typed edges with runtime validation.
- `Result<T, E>` for expected failures; explicit domain errors.
- Exhaustive `switch` with `assertNever` on node kinds.
- Tests for every fixture and security case (see `test/`).

## Lifecycle of a change

1. Write the failing test (fixtures live in `test/fixtures/`).
2. Implement, keeping the graph deterministic and explainable.
3. Add an ADR entry when you make an architectural decision.
4. Run typecheck + full test suite.
5. Update `CHANGELOG.md` and relevant docs.

## Where to look

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the modules fit together
- [docs/](docs/) — concept docs, ADRs, threat model
- Add new concept/ADR/security notes to `docs/` and link them from
  [docs/README.md](docs/README.md).
