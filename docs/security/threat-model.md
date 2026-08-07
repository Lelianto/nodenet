# NodeNet Threat Model

NodeNet treats the repository as an adversarial environment. This document
enumerates the threats the design defends against and the controls in place.

## Trust boundaries

| Boundary | Trusted? | Notes |
| --- | --- | --- |
| NodeNet source code | trusted | our own code |
| `nodenet.config.json` | untrusted | data only, never executed |
| Repository source/comments | untrusted | evidence, never instructions |
| Git data / refs / branch names | untrusted | validated, arg arrays only |
| `.nodenet/*` persisted data | untrusted | runtime-validated on load |
| Future plugins | trusted explicitly | documented code-execution grant |

## Threat matrix

| # | Threat | Control |
| --- | --- | --- |
| 1 | Malicious repository (weaponized source) | no execution; parsing only; limits |
| 2 | Malicious PR content (prompt injection) | comments are evidence; output sections are provenance-marked; hardened context outranks arbitrary text |
| 3 | Malicious symlink escaping the root | `resolveSafe` realpath re-check; scanner skips out-of-root symlinks |
| 4 | Malicious config (types, globs) | Valibot runtime validation; JSON-only config |
| 5 | Malformed AST | parser never throws; syntax errors reported as warnings; per-file budget |
| 6 | Huge files | `maxFileSizeBytes` → skip with warning |
| 7 | Dependency bombs | `maxFiles`, `maxGraphNodes`, `maxGraphEdges` |
| 8 | Deep graph cycles | visited set + `maxTraversalDepth` + `maxTraversalNodes` in all traversals |
| 9 | Prototype pollution payloads in JSON | parsed JSON is validated structurally; node/edge records are re-created, never spread from raw input |
| 10 | ReDoS via globs/config patterns | deterministic hand-written glob matcher (no user-supplied regex) |
| 11 | Path traversal (`../`, absolute, `C:\`) | `SafeRelativePath` rejects; `resolveSafe` containment check |
| 12 | Command injection via refs/branches | `isValidRef` + `spawn` arg arrays; no shell |
| 13 | Unsafe git invocation | `git -C <root> ...` with literal args |
| 14 | Secret leakage | secret-file patterns never scanned; `detectSecrets` on AI output; audit log excludes secrets |
| 15 | Audit log pollution with secrets | audit entries contain identifiers/metadata only, never file contents |

## Safe GitHub Actions (future)

When the GitHub Action ships (spec §21, §56):

- Run NodeNet as its own step, not from PR-controlled code.
- Use `pull_request` triggers with `contents: read` and `pull-requests: write`
  only. Never `contents: write`.
- Never pass repository secrets to steps that read PR content.
- Review-request automation must be gated on severity threshold, ownership
  source, authority source and repository policy (spec §57).

## Out of scope for v0.1

- Sandboxed plugin execution (explored later, spec §44).
- Remote/corrupt-storage adversarial models (local-first JSON is validated but
  not encrypted).

## See also

- [SECURITY.md](../../SECURITY.md) — security guarantees and reporting
- [ADRs](../adr/) — how the relevant defenses are implemented
  (runtime validation, graph storage)
- [../README.md](../README.md) — documentation index
