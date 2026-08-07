# ADR 003: Graph storage

- Status: accepted
- Date: 2026-08-07

## Context

NodeNet is local-first and must stay lightweight (spec §52). Candidates:
local JSON files, SQLite, embedded graph DBs (Neo4j/Redis are explicitly
non-goals for v0.1).

## Decision

**Local JSON files in `.nodenet/`**:

```
.nodenet/
  graph.json      # full unified graph snapshot (nodes + edges + metadata)
  index.json      # per-file fingerprints (size + mtime) for incremental updates
  symbols.json    # per-file symbol line ranges (symbol-level diff after reload)
  context.json    # user-authored living context (also contexts/*.json)
  ownership.json  # user-authored explicit ownership
  suppressions.json
  audit.jsonl     # append-only governance audit
  metadata.json   # build metadata
```

## Rationale

- Zero external dependencies; trivially debuggable and diffable.
- Deterministic and versioned (`metadata.version`).
- The snapshot format is small enough for v0.1 repositories.

## Storage interface

`src/storage/storage.ts` owns persistence. `Graph.fromSnapshot` / `toSnapshot`
are the serialization boundary, so a future SQLite or embedded-graph backend can
replace the JSON writer without changing the graph model.

## Security

Persisted data is untrusted on load: every node/edge record is structurally
validated, and `Graph.fromSnapshot` re-checks relation legality. Corrupt files
produce typed errors, not crashes.

## Consequences

- Very large repositories will eventually outgrow whole-snapshot writes;
  incremental edge patches (spec §37) plus a real storage backend are the
  documented next step.
- Fingerprint + symbol caches enable the `update` command and future
  true-incremental rebuilds (spec §51).

## See also

- [../README.md](../README.md) — documentation index
- [001-parser.md](001-parser.md) — the parser feeding the persisted graph
- [002-runtime-validation.md](002-runtime-validation.md) — how snapshots are
  re-validated on load
- [../../docs/concepts/graph.md](../concepts/graph.md) — the graph model this
  stores
