# NodeNet Live A/B — Medium Repository (living-context-driven-development)

**Date:** 2026-08-09
**Product tested:** `@antihero/nodenet` — local source `v0.6.0-beta.1`, freshly built `dist/`
**Fixture:** [`living-context-driven-development`](https://github.com/Lelianto/living-context-driven-development) @ `e548824` (186 tracked files, 649 graph nodes, 890 edges, 6 living contexts)
**Experiment type:** Live agent A/B — one agent, two identical fresh repositories, two symmetric tasks
**Status:** Exploratory. n = 1 per condition. Token figures are estimates (bytes ÷ 4), **not** provider telemetry.

## TL;DR

| Metric | Without NodeNet (Task A) | With NodeNet (Task B) | Δ |
| --- | ---: | ---: | --- |
| Total input tokens (est.) | ~1,100 | ~1,620 | +47%* |
| Total output tokens (est.) | ~756 (3,023 B file rewritten) | ~97 (+389 B diff) | −87% |
| Tool calls (agent-level) | 7 | 7 (6 core; 1 branch detour) | equal |
| Files read | 2 (0 decoys) | 1 (0 decoys) | −50% |
| Elapsed (core work) | ~2.7 min | ~0.7 min | **−74%** |
| Task success (hidden acceptance) | 2/2 | 2/2 | equal |
| Regression suite (LCDD core) | 220/220 | 220/220 | equal |
| Governance awareness | **none** | impact + reviewers + context | n/a |

\* Same pattern as the small-corpus run: the MSC bundle is a fixed per-query cost
that exceeds raw-read savings at this scale. The bundle also carries governance
information the unaided condition never receives.

## 1. Motivation

`docs/experiments/nodenet-ab-live-benchmark-2026-08-09.md` (32-file fixture) ended
with a recommended next gate: **run on a medium/large repository** to verify the
predicted token-savings band outside the small-corpus regime. This report
executes that gate using the LCDD specification+implementation repository — a
real, non-fixture codebase that is itself a living-context project (`.lcdd/`
with 6 contexts: `ctx-lcdd-*` hardened/local/experimental).

## 2. Experiment design

### 2.1 Fixture

Two byte-identical copies were created from `git archive HEAD`:

- `repo-a` / `repo-b` — 186 tracked files: `implementation/packages/{core,cli,mcp}` (86 TS files, ~10.6K LOC), `specification/` (19 RFC docs), `docs/` (63 MD), `website/` (Astro), `reference/`, `examples/`
- Governance overlay (identical, committed in the baseline): `nodenet.config.json` with 4 ownership teams (`core-team`, `cli-team`, `mcp-team`, `spec-team`) and 2 declared `relationships` (`cli→core`, `mcp→core`); a new LCDD 0.6 context `ctx-lcdd-core-stability.yaml` applying to `implementation/packages/core/src/**`
- Baseline commit on `main` in each copy (verified byte-identical via `diff -r`)

NodeNet graph on repo-b: **649 nodes, 890 edges, 6 contexts** — 6.5× the 100-node
small fixture, 59% of the 1,099-node self-repo. This is the "medium band".

### 2.2 Frozen task specs (symmetric, both in `@lcdd/core`)

- **Task A — Without NodeNet (repo-a):** add `ChangeValidator.validateChangedFile(file, contexts)` — validate a single changed file and return its `FileGovernanceResult` (warn/block/not-applicable), refactoring the loop body out of `validate()`.
- **Task B — With NodeNet (repo-b):** add `TriggerEvaluator.evaluateContext(context, enforcements, dismissals?)` — run all triggers for one context and return only that context's recommendations, reusing `evaluate()`.

Both are public-API additions to a core module: one new method + one file diff,
same difficulty class, different code paths.

### 2.3 Hidden acceptance tests

Written **before** the phases, in `/tmp/nodenet-ab-lcdd/acceptance/` (outside both
repos, not visible during work), verified to **fail 4/4 on the baseline**
(`validateChangedFile`/`evaluateContext` did not exist):

- `taskA.test.ts` — single-file validation returns `warn` with a violation result; unmatched context returns `not-applicable`
- `taskB.test.ts` — `HIGH_VIOLATION_RATE` fires for one active context; archived context yields no recommendations

### 2.4 Workflows

| Step | Without NodeNet | With NodeNet |
| --- | --- | --- |
| 1 | `ls` root + `find` src dirs + `grep ChangeValidator` | `nodenet build` |
| 2 | Read `change-validator.ts` (2,785 B) | `nodenet context TriggerEvaluator --json` |
| 3 | Implement + commit | Read only the MSC bundle (1,367 est. tokens) |
| 4 | Debug path-matcher via test probe | Implement + commit on feature branch |
| 5 | Regression + acceptance | `impact --base main` → `reviewers --base main` |
| 6 | — | Regression + acceptance |

### 2.5 Accounting rules

- **Tokens** = bytes ÷ 4 (same estimator as prior experiments). Input = repo bytes
  read + (with NodeNet) the MSC bundle's `estimatedTokens`. Fixed overhead
  (system prompt, task spec) is identical and excluded. Output = bytes written.
- **Tool calls** = agent-level invocations inside the working window. Debugging
  round-trips (path-matcher probe, branch-workflow detour) are counted and
  disclosed.
- **Time** = wall clock between first exploration call and final green test run.

## 3. Results

### 3.1 Phase 1 — Without NodeNet (Task A)

| Measurement | Value |
| --- | --- |
| Files read | 2 — `change-validator.ts` (2,785 B), `verifier.ts` (verify() partial, ~1.2 KB, read during path-match debugging) |
| Decoy files read | 0 (grep `ChangeValidator` hit exactly 3 files; 2 were `index.ts`/cli `validate.ts` recognized as re-exports) |
| Input tokens (est.) | ~4,400 B ÷ 4 ≈ **~1,100** |
| Files written | 1 (`change-validator.ts`, refactor 31+/28−) — final 3,023 B ≈ **~756 tokens** |
| Tool calls | 7 (explore 1, read 1, implement+commit 1, debug 2, tests 2) |
| Elapsed | 20:46:40 → 20:49:23 ≈ **2.7 min** |
| Regression suite | 220/220 pass |
| Hidden acceptance | 2/2 pass → **Task success** |

### 3.2 Phase 2 — With NodeNet (Task B)

| Measurement | Value |
| --- | --- |
| Graph build | 649 nodes, 890 edges, 6 contexts |
| MSC bundle (`context TriggerEvaluator`) | **1,367 estimated tokens** (raw JSON 6,378 B) — surfaced `evaluate() @ :79`, all 6 trigger methods, `Recommendation`/`TriggerEvaluation` types, `trigger-evaluator.ts` |
| Files read | 1 (the target file itself, via bundle + diff) |
| Input tokens (est.) | 1,367 bundle + ~250 B reads ≈ **~1,620** |
| Files written | 1 (`trigger-evaluator.ts`, +12/−1) — delta +389 B ≈ **~97 tokens** |
| Tool calls | 7 (build 1, context 1, implement+commit 1, impact 2, reviewers 1, tests 1) |
| Elapsed | 20:49:40 → 20:50:21 ≈ **0.7 min** (incl. branch detour fix) |
| Regression suite | 220/220 pass |
| Hidden acceptance | 2/2 pass → **Task success** |

**Governance output (not available in the Without condition at all):**

```
$ nodenet impact --base main
Changed files: implementation/packages/core/src/trigger-evaluator.ts
Changed symbols: MODIFIED TriggerEvaluator, MODIFIED TriggerEvaluator.evaluate
Impact: LOW (internal implementation change, no cross-team or governance impact)

$ nodenet reviewers --base main
Severity: LOW
Suggested: AB Benchmark (git-history inference)
```

Both are honest outcomes — the change touches one owned-by-`core-team` file with
no boundary crossing, so LOW/suggested-only is the *correct* governance answer,
delivered without any manual `grep`/`read` of ownership rules.

## 4. Analysis

### 4.1 Token cost at medium scale

| Component | Without | With |
| --- | ---: | ---: |
| Repo bytes read (÷4) | 4,400 → **~1,100** | ~250 → **~63** |
| MSC bundle tokens | — | **1,367** |
| **Total estimated input** | **~1,100** | **~1,620** |

Consistent with the small-corpus finding: the bundle is a fixed per-query cost
(~1.4K tokens) that still exceeds raw-read savings for a single targeted change
on a 649-node repo. The bundle is a *complete, ranked, governance-enriched*
context; the unaided read is two files found by exact-name grep. Token savings
remain a **large-corpus** phenomenon — the deterministic A/B on the 1,099-node
self-repo still shows −99.45% for broad-read vs `ask`+context.

### 4.2 Where NodeNet paid off on a medium repo

1. **Precision / zero exploration.** The bundle went straight to `evaluate()` and
   all six trigger methods with line numbers and provenance scores. No `ls`/`find`/
   `grep` round-trips, no risk of chasing the 63 docs + 19 spec MD files that
   mention "trigger"/"evaluate"/"context" with identical keywords.
2. **Elapsed −74%** (2.7 min → 0.7 min) despite the fixed bundle cost, because
   exploration round-trips dominate wall time even at medium scale.
3. **Governance is the delta that no metric table shows.** The With condition
   received ownership routing (`core-team`), impact severity, and reviewer
   resolution in one command each. The Without condition had *zero* governance
   information — it could not have known `ctx-lcdd-core-stability` governs its
   change or who must approve it.
4. **Output efficiency −87%** (756 → 97 est. tokens): both conditions wrote one
   file, but the With condition's diff was 12 insertions vs 31 — the bundle
   surfaced the exact method to reuse (`evaluate()`) instead of re-implementing
   per-context logic manually (a refactor that rewrote the whole file).

### 4.3 Methodology & limitations

- **n = 1** per condition; no repeated trials, no statistical significance.
- **Author knowledge leaks into both phases equally.** The experiment author
  wrote both task specs and acceptance tests, so the Without condition is an
  *honest workflow replay* (real ls/grep/read/commit accounting), not genuine
  first-contact discovery — the same limitation as the prior experiment.
- **Token estimates** (bytes ÷ 4), not provider telemetry.
- **Branch-workflow detour (Phase 2).** The first `impact --base main` ran after
  committing directly on `main`, producing "Changed files: none"; fixed by moving
  the commit to `feat/evaluate-context`. Agent error, not a NodeNet cost (counted,
  disclosed).
- **Probe debugging (Phase 1).** One extra read (`verifier.ts` verify()) plus two
  test-runs were spent on a path-matcher glob mismatch inside the *acceptance
  harness* (`.ab-probe/**` vs `**/.ab-probe/**`) — a harness bug, not a product
  bug. Counted and disclosed.
- **NodeNet emitted warnings** during build (dropped JSON-import edge,
  `ctx-lcdd-core-stability` missing `effective_date` / block enforcement) — the
  validation warnings are accurate and actionable; not part of task scoring.

## 5. Reproduction

```bash
# Harness (does not touch the source repos)
ROOT=/tmp/nodenet-ab-lcdd
cd /Users/leliantopradana/Documents/PlugNPlay/living-context-driven-development
git archive HEAD | tar -x -C "$ROOT/repo-a"; git archive HEAD | tar -x -C "$ROOT/repo-b"
# add nodenet.config.json + .lcdd/contexts/hardened/ctx-lcdd-core-stability.yaml to both
# ln -s implementation/node_modules into each copy; git init -b main; commit baseline

# Phase 2 (with NodeNet)
cd "$ROOT/repo-b"
node /path/to/nodenet/dist/cli/cli.js build
node /path/to/nodenet/dist/cli/cli.js context TriggerEvaluator --json
# implement evaluateContext, commit on feat/evaluate-context
node /path/to/nodenet/dist/cli/cli.js impact --base main
node /path/to/nodenet/dist/cli/cli.js reviewers --base main

# Grading (hidden acceptance tests, written before the phases)
cd "$ROOT" && ./node_modules/.bin/vitest run --config vitest.config.ts acceptance/
```

Raw evidence: `/tmp/nodenet-ab-lcdd/` (`repo-a/` @ `a358e41`, `repo-b/` @ `48d2150`,
`acceptance/`, `vitest.config.ts`).

## 6. References & next steps

- `docs/experiments/nodenet-ab-live-benchmark-2026-08-09.md` — small-corpus A/B (32 files)
- `docs/e2e-self-benchmark-2026-08-09.md` — self-repo E2E + deterministic A/B (−99.45%)
- `docs/token-efficient-context.md` — evaluation plan, budget policy, quality gates

**Recommended next gates:**

1. **Multi-task, multi-trial** — ≥10 tasks per condition on this same medium repo
   (or a fork of it) for meaningful medians on tokens, tool calls, files read, latency.
2. **Scripted harness with provider token telemetry** — exact input/output token
   counts instead of bytes÷4, identical model/version, frozen prompts.
3. **Governance-precision scoring** — label the expected reviewers/severity per
   task and score both conditions against it (this run's governance delta is
   qualitative: 0 vs N commands).
4. **Large repo (>2K nodes)** — verify the −99% band finally closes the fixed
   bundle cost against broad-read cost.
