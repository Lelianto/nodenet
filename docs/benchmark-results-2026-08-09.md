# NodeNet Initial Benchmark Report — 2026-08-09

## Scope and interpretation

This is a reproducible local pilot, not a production-quality claim. It covers
parser regression, repository retrieval, media-candidate retrieval, governance
decision replay, and adversarial controls. The corpus is deliberately small, so
all perfect scores must be read together with the sample count.

Environment: Node.js 26.3.1, macOS, NodeNet 0.5.0 source at base revision
`b93251d` plus the uncommitted implementation under evaluation. Timings are
wall-clock observations and will vary by machine.

## Summary

| Layer | Cases | Primary result |
| --- | ---: | --- |
| Parser regression | 20 (2 × 10 languages) | 100% pass; precision/recall/import recall 1.0 for every language |
| Retrieval | 2 labeled questions | file precision 0.875; file recall 1.0; mandatory-context recall 1.0 |
| Governance replay | 1 labeled Git change | outcome accuracy 1.0; reviewer precision/recall 1.0; missed-impact rate 0 |
| Adversarial controls | 21 automated tests | 21 passed |
| Full regression | 181 automated tests | 181 passed |

## 1. Ten-language parser regression

Command:

```bash
npm run build
node dist/cli/cli.js benchmark-languages --json
```

The benchmark runs one positive declaration/import fixture and one
comment-based false-positive fixture for TypeScript, JavaScript, Python, Go,
Java, C#, PHP, Rust, Ruby, and Kotlin. All 20 cases passed. Every language
reported symbol precision `1.0`, symbol recall `1.0`, and import recall `1.0`.

This benchmark found real defects before the final run: comment lines were
being interpreted as declarations in C#, Java, Kotlin, PHP, and Rust. The
generic parser now rejects comment-leading lines. Remaining gap: the fixtures
do not yet represent framework-heavy or macro/metaprogramming-heavy real-world
repositories.

## 2. Retrieval, context, and media

Command:

```bash
cd examples/payments-demo
node ../../dist/cli/cli.js build
node ../../dist/cli/cli.js benchmark-retrieval \
  --dataset retrieval-benchmark.json --json
```

Results:

| Case | Precision | Recall | Context recall | MSC tokens | Dataset-baseline reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Payment settlement code/context | 0.75 | 1.0 | 1.0 | 1,243 | 68.92% |
| Payment architecture media | 1.0 | 1.0 | 1.0 (no mandatory contexts) | 368 | 90.80% |

Aggregate file precision was `0.875`; file recall and mandatory-context recall
were both `1.0`. The extra file in the first case was
`SettlementSchema.ts`, a relevant graph neighbor not included in the strict
three-file label. It counts against precision even though it is defensible
context.

Media evaluation uses an SVG plus a bounded `.nodenet.json` sidecar. It proves
candidate ingestion and retrieval, not native vision/audio/video understanding.
Media concepts remain inferred and non-authoritative.

## 3. Governance and Git replay

Command:

```bash
npm run build
node scripts/benchmark-governance-fixture.mjs
```

The runner creates an isolated Git repository, commits the cross-team payment
baseline on `main`, commits a behavior change on a feature branch, builds the
graph, and evaluates the diff against the manually labeled expectation.

Observed result:

- Expected and actual outcome: `block`.
- Expected and actual reviewers: `finance-team`, `payment-team`, and
  `security-team`.
- HARDENED impact expected and detected.
- Outcome accuracy, reviewer precision, and reviewer recall: `1.0`.
- False-block rate and missed-impact rate: `0`.
- Observed p50/p95 for this one case: 35–39 ms across the recorded verification runs.

Because `n=1`, latency percentiles and error rates are smoke-test indicators,
not statistically meaningful estimates. The run also exposed a metric bug:
zero eligible non-block cases were previously reported as a false-block rate of
1. The error-rate denominator now correctly returns 0 when no error opportunity
exists.

## 4. Adversarial and safety evaluation

Command:

```bash
npx vitest run test/security.test.ts test/property.test.ts test/mcp-http.test.ts
```

All 21 tests passed. Covered controls include path traversal, out-of-repository
symlinks, oversized files, secret-like paths and values, prompt-injection text
in comments, graph limits, traversal properties, MCP authorization/session
lifecycle, stale snapshot replacement, request limits, and cancellation.

The complete suite also passed: 23 test files and 181 tests.

## 5. Deterministic A/B token pilot

This pilot compares two retrieval policies, not two independently operating LLM
agents:

- A (broad read): read the authored payments-demo corpus. The corpus is 30,241
  characters, approximately 7,560 tokens using the same four-characters-per-token
  estimator. This includes the checked-in graph preview SVG; excluding broad
  visual assets would materially reduce A's cost.
- B (NodeNet): run `ask`, then build bounded evidence context. It used 1,243
  estimated tokens for the code/context task and 368 for the media task.

Both B cases retained 100% labeled file recall and mandatory-context recall.
Against this broad-read estimate, reductions are approximately 83.6% and 95.1%.
The committed benchmark dataset uses a more conservative 4,000-token baseline,
producing the reported 68.92% and 90.80% reductions.

This is not yet evidence that an LLM completes edits more accurately. A proper
agent A/B needs frozen prompts, the same model/version and token accounting,
hidden acceptance tests, repeated trials, and human-labeled task success.

## Decision and next benchmark gate

The pilot is sufficient to keep the new retrieval/MCP direction and begin a
design-partner trial. It is not sufficient for public comparative claims.
Before such claims, expand to at least three real repositories per language
tier, 30+ labeled retrieval questions, 30+ historical governance diffs including
non-block cases, and repeated model-based A/B tasks with confidence intervals.
