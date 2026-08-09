# NodeNet Token Levers and Break-Even Curve

**Date:** 2026-08-09
**Product tested:** `@antihero/nodenet` — local source `v0.6.0-beta.1`, freshly built `dist/`
**Repository under test:** NodeNet self-repository (1,103 graph nodes, 1,820 edges) plus five additional corpora
**Status:** Deterministic measurement. No LLM in the loop, no wall-clock claims. Token figures are estimates (bytes ÷ 4), **not** provider telemetry.
**Harnesses:** [`scripts/token-levers-probe.mjs`](../../scripts/token-levers-probe.mjs), [`scripts/token-breakeven-curve.mjs`](../../scripts/token-breakeven-curve.mjs)

## TL;DR

| Finding | Measured |
| --- | --- |
| Two bundle fields are redundant or derivable and cost a third of the payload | Median **−32.2%** compact bytes, 12/12 targets above −25%, provably lossless on 12/12 |
| `metrics.estimatedTokens` under-counts what is actually emitted | Median reported **1,127** vs median emitted **1,410** tokens (+25%) |
| The soft budget is advisory, not enforced | 1/12 targets exceeded its own budget (2,007 > 2,000) |
| `ask` spends three quarters of its payload on fields an agent does not need | `matches` + `connections` = **73.4%** of payload; lean projection **−97.5%** |
| A files-plus-governance profile costs almost nothing | Median **154.5** tokens (range 117–194), **−88.0%** vs compact |
| NodeNet's token break-even is far lower than v1 assumed | Default wins from **159 nodes**, not ~1,000 — against *both* baselines |

The headline correction to [`token-efficiency-strategy.md`](../future-plan/token-efficiency-strategy.md): v1 concluded NodeNet is "a large-repository token-saving tool" that needs tuning below ~1,000 nodes. Measured against a like-for-like baseline, **the default already wins from ~159 graph nodes**. v1's pessimism came from comparing a rich bundle against an *expert* two-file read, not from a break-even curve.

## 1. Why this experiment exists

[`token-efficiency-strategy.md`](../future-plan/token-efficiency-strategy.md) § 11 listed five gaps blocking any published token claim. Two of them are addressed here:

- Gap 3 — "a measured break-even curve across corpus sizes (100 → 300 → 649 → 1,099 → 2,000+ nodes)".
- Gap 2 (partially) — accounting accuracy: this experiment shows the current estimator is systematically low, which must be fixed before telemetry-grade claims.

It also tests a claim I could not previously justify: an earlier single-target measurement suggested removing two bundle fields saves 34.6%. n=1 is not evidence, so the probe runs 12 targets and gates on breadth.

## 2. Method

### 2.1 Lever probe

`scripts/token-levers-probe.mjs` runs the real CLI (`context <target> --detail evidence --no-cache --json`) for 12 targets spanning 11 source modules, then measures the same bundle under seven serializations:

| Variant | Definition |
| --- | --- |
| `prettyDefault` | stdout exactly as emitted today (`JSON.stringify(v, null, 2)`, [src/cli/cli.ts:294](../../src/cli/cli.ts)) |
| `compactDefault` | `JSON.stringify(v)` — what `estimateTokens` measures ([src/ai/context-builder.ts:230](../../src/ai/context-builder.ts)) |
| `compactNoCodeContext` | minus `codeContext` |
| `compactNoSelectionReason` | minus every `selectionReason` |
| `compactTier1` | minus both |
| `profileMap` | field-projected: evidence reduced to `id`, `label`, `path`, `relation`, `direction` |
| `profileRoute` | proposed profile: files + ownership + governance + guidance, no code evidence |

Four `ask` questions are measured full versus lean-projected (`intent` + primary/supporting file paths + `suggestedNext`).

Targets: `buildContextBundle`, `askGraph`, `attachRepositoryArtifacts`, `authorityRank`, `loadConfig`, `adaptLcddContext`, `scoreBenchmark`, `analyzeImpact`, `resolveReviewers`, `secureToolOutput`, `buildGovernanceDecision`, `estimateTokens`.

### 2.2 Losslessness checks

A saving that removes information is not a saving. The probe therefore asserts, per case:

- `codeContext` is byte-identical to `codeEvidence.map(item => item.label)` — so dropping it removes a duplicate, not data.
- Every `selectionReason` equals the exact template that generates it from `direction`, `relation`, `depth`, `provenance`, and `score` ([src/ai/context-builder.ts:389](../../src/ai/context-builder.ts)) — so it is derivable by the consumer and need not be transmitted.
- The lean `ask` projection preserves `recommendedFiles` — the files an agent would actually open.

Both bundle checks passed on 12/12 cases; the `ask` check passed on 4/4.

### 2.3 Break-even curve

`scripts/token-breakeven-curve.mjs` copies each corpus to a temp directory (source repositories are never mutated), builds the graph, deterministically selects the 5 highest-degree code symbols, and compares NodeNet variants against two unaided baselines:

| Baseline | Definition | Models |
| --- | --- | --- |
| `grepped read` | Sum of bytes of every authored file containing the target identifier | An agent that opens every grep candidate |
| `best-case read` | Bytes of the single file that defines the target | A perfect-luck agent that opens exactly one correct file |

The second baseline exists because it is the strictest honest bound: no unaided agent can do better than reading the one file it needs. Reporting only the first baseline would flatter NodeNet.

Corpora span 14 → 1,236 nodes. Three self-repository module subsets fill the 159–538 node band, which no real corpus on this machine occupied — without them the curve had a 22× gap across precisely the medium band that v1's conclusion turned on.

## 3. Results — bundle levers

Graph: 1,103 nodes, 1,820 edges. All figures in tokens (bytes ÷ 4).

| Target | Evidence | Pretty (emitted) | Compact | Tier 1 lean | Tier 1 saving | Profile map | Profile route |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `buildContextBundle` | 19 | 2,464 | 2,008 | 1,312 | 34.6% | 1,117 | 124 |
| `askGraph` | 20 | 2,383 | 1,907 | 1,228 | 35.6% | 1,024 | 117 |
| `attachRepositoryArtifacts` | 10 | 1,408 | 1,119 | 774 | 30.9% | 669 | 185 |
| `authorityRank` | 8 | 1,178 | 959 | 658 | 31.4% | 574 | 123 |
| `loadConfig` | 19 | 2,283 | 1,831 | 1,183 | 35.4% | 990 | 118 |
| `adaptLcddContext` | 10 | 1,308 | 1,048 | 702 | 33.1% | 598 | 119 |
| `scoreBenchmark` | 9 | 1,353 | 1,079 | 756 | 30.0% | 661 | 192 |
| `analyzeImpact` | 6 | 980 | 769 | 558 | 27.5% | 493 | 186 |
| `resolveReviewers` | 5 | 860 | 671 | 499 | 25.8% | 444 | 189 |
| `secureToolOutput` | 17 | 2,176 | 1,736 | 1,151 | 33.7% | 978 | 194 |
| `buildGovernanceDecision` | 9 | 1,412 | 1,136 | 797 | 29.9% | 703 | 193 |
| `estimateTokens` | 18 | 2,378 | 1,942 | 1,277 | 34.3% | 1,094 | 123 |

- **Tier 1 (drop `codeContext` + `selectionReason`): median −32.2%**, range −25.8% to −35.6%, **12/12 cases at or above −25%**. The saving scales with evidence count, as expected: 5-item targets save ~26%, 20-item targets ~36%.
- **Pretty-to-compact: median −19.9%.** This is pure serialization whitespace with no information content.
- **Profile `map` (field projection): median −41.6%** — materially better than today's `map` detail level, which only caps item count and leaves the field shape untouched ([src/ai/context-builder.ts:171](../../src/ai/context-builder.ts)).
- **Profile `route`: median 154.5 tokens (range 117–194), −88.0%.** Remarkably flat across targets, because governance and ownership payloads barely vary — on `buildContextBundle` the entire governance core is 359 B against 6,446 B of `codeEvidence`.

### 3.1 The estimator under-counts

Median reported `estimatedTokens` is **1,127**; median actually-emitted payload is **1,410 tokens (+25.1%)**. The cause is a two-line mismatch: `estimateTokens` serializes compact ([src/ai/context-builder.ts:230](../../src/ai/context-builder.ts)) while both emitters pretty-print with indent 2 ([src/cli/cli.ts:294](../../src/cli/cli.ts), [src/mcp/security.ts:37](../../src/mcp/security.ts)).

Consequence: every token figure in the v1 strategy document and in `benchmark-retrieval` is roughly 20–25% optimistic. This must be corrected before any published claim, and it is the reason the release gates in [`token-efficient-context.md`](../token-efficient-context.md) cannot currently be trusted as written.

### 3.2 The budget is advisory

`buildContextBundle` reported `estimatedTokens` 2,007 against `budgetTokens` 2,000. This is by design, not a bug: governance evidence is assembled before the budget loop and is never trimmed ([src/ai/context-builder.ts:122-142](../../src/ai/context-builder.ts)). The design guarantee is correct — mandatory governance must survive — but the *reporting* is not: `metrics.truncated` is derived from omitted nodes, not from budget overflow, so a caller cannot tell that its budget was exceeded.

## 4. Results — `ask` payload

| Question | Matches/Connections | Pretty (emitted) | Compact | Lean | Lean saving | matches+connections share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| how is the context bundle budget applied | 30/33 | 5,620 | 4,292 | 88 | 98.0% | 76.5% |
| who reviews a governance change | 30/28 | 5,525 | 4,231 | 135 | 96.8% | 71.2% |
| how are living contexts loaded from disk | 30/24 | 4,924 | 3,731 | 93 | 97.5% | 73.1% |
| where is the MCP output secret scan | 30/28 | 5,212 | 3,907 | 103 | 97.4% | 73.7% |

- Median lean saving **−97.5%**: 98 tokens against 5,368 emitted.
- `matches` + `connections` are a median **73.4%** of the payload.
- The lean projection preserved `recommendedFiles` on **4/4** cases.

This confirms and generalizes the "ask trap" v1 identified qualitatively. v1's remedy was advice to agents (`jq .recommendedFiles`). The measurement shows the real problem is the **default**: `ask` has no field projection at all ([src/ai/retrieval.ts:45-62](../../src/ai/retrieval.ts)), so the expensive shape is the one every caller gets first.

## 5. Results — break-even curve

Medians over 5 deterministically selected highest-degree symbols per corpus.

| Corpus | Graph nodes | Authored files | Grepped read | Best-case read | Default (emitted) | Tier 1 lean | Profile route |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Fixture: monorepo | 14 | 5 | 60 | 27 | 609 | 353 | 101 |
| Fixture: basic TypeScript | 18 | 4 | 68 | 68 | 544 | 303 | 93 |
| Example: payments demo | 52 | 16 | 943 | 105 | 1,925 | 1,094 | 213 (beats grep only) |
| Self subset: core types + context | 159 | 22 | 4,885 | 2,626 | **1,680** | **896** | **119** |
| Self subset: + ai + parser | 312 | 33 | 5,076 | 3,879 | **2,383** | **1,228** | **120** |
| Self subset: + graph + governance | 538 | 55 | 6,758 | 2,816 | **2,418** | **1,252** | **117** |
| NodeNet self-repository | 1,170 | 209 | 8,887 | 8,887 | **2,225** | **1,200** | **117** |
| LCDD spec + implementation | 1,236 | 187 | 18,990 | 8,404 | **2,222** | **1,389** | **135** |

Bold entries beat **both** baselines.

| Variant | Break-even vs grepped read | Break-even vs best-case read |
| --- | --- | --- |
| Default (emitted) | between 52 and 159 nodes | between 52 and 159 nodes |
| Tier 1 lean | between 52 and 159 nodes | between 52 and 159 nodes |
| Profile route | between 18 and 52 nodes | between 52 and 159 nodes |

The two baselines converge on the same answer, which is the strongest form of this result: **the conclusion does not depend on which baseline you consider fair.**

Two further observations:

1. **NodeNet's cost is genuinely flat.** From 159 to 1,236 nodes — an 8× corpus increase — the default bundle moved 1,680 → 2,222 tokens while the grepped baseline moved 4,885 → 18,990. This is the fixed-versus-linear economics v1 described, now measured across the curve rather than at two endpoints.
2. **Below ~50 nodes NodeNet is not a token-saving tool**, and the route profile is the only variant that is even close. v1's guidance for small repositories (use NodeNet for governance and precision, not tokens) survives unchanged.

## 6. Reconciling with the v1 medium-repo benchmark

[`nodenet-ab-lcdd-medium-benchmark-2026-08-09.md`](nodenet-ab-lcdd-medium-benchmark-2026-08-09.md) reported NodeNet **+47%** input tokens on the 649-node LCDD repository. This experiment reports NodeNet **winning** at 1,236 nodes on the same repository. Both are correct; they measure different baselines:

| | Medium A/B (v1) | This experiment |
| --- | --- | --- |
| Baseline | An expert who grepped once, recognized two of three hits as re-exports, and opened 2 files (~1,100 tokens) | Every file containing the identifier (grepped read), and the single defining file (best-case read) |
| Baseline knowledge | Written by the author of the task and the acceptance tests | None — deterministic selection |
| NodeNet figure | `metrics.estimatedTokens` (1,367) | Emitted payload (~2,222), which is the honest, larger number |

The v1 comparison therefore pits an *optimally lucky* human-guided read against a *reported-not-emitted* NodeNet cost. This experiment uses the harsher NodeNet number and two mechanical baselines, and NodeNet still wins. The `best-case read` column is the direct analogue of v1's expert read, and NodeNet beats it from 159 nodes onward.

The honest summary: v1 was too pessimistic about break-even and simultaneously too optimistic about NodeNet's absolute cost.

## 7. Limitations

- **Estimator, not telemetry.** All figures are bytes ÷ 4. Real tokenizers differ per model, and JSON punctuation tokenizes worse than prose, so absolute values are approximate. Ratios between variants of the *same* payload are reliable; cross-format comparisons (JSON versus source code) are less so.
- **No LLM in the loop and no task-success measurement.** This experiment measures retrieval payload cost, not whether an agent completes tasks. A payload reduction that harms task success is a regression, and this harness cannot detect that. The `e2e-self` retrieval gates and the graded-relevance benchmark remain the quality guards.
- **The `route` profile is measured by projection, not implementation.** Numbers show what the field set costs, not that a real `--profile route` returns exactly those fields.
- **Subset corpora are synthetic.** The 159/312/538-node points are module subsets of one repository, so they share its coding style and governance overlay. They fill the band credibly but are not independent codebases.
- **Baseline models file reading, not tool overhead.** Real unaided agents also spend tokens on `ls`, `find`, `grep` output and on failed reads. Both baselines therefore *understate* unaided cost, which biases against NodeNet — acceptable for a conservative claim.
- **`fixture-react-app` was skipped** (no eligible code symbols — its components are not extracted under the kinds this harness selects).
- **5 targets per corpus, 12 for the lever probe.** Enough for a median and a breadth gate, not enough for confidence intervals.

## 8. Gates

The lever probe fails (exit 2) unless all five hold. Current run: all pass.

| Gate | Requirement | Result |
| --- | --- | --- |
| `tier1-breadth` | Tier 1 saves ≥25% of compact bytes on ≥10 of 12 targets | PASS (12/12) |
| `tier1-lossless` | `codeContext` duplicates evidence labels and `selectionReason` is derivable, every case | PASS (12/12) |
| `ask-lean` | Lean `ask` projection saves ≥90% of compact bytes (median) | PASS (97.5%) |
| `ask-lean-lossless` | Lean `ask` projection preserves `recommendedFiles`, every case | PASS (4/4) |
| `estimator-undercount` | Reported `estimatedTokens` is below the emitted payload | PASS (1,127 vs 1,410) |

The last gate is inverted on purpose: it passes while the accounting bug exists, and will start failing once the estimator is fixed. That failure is the signal to retire the gate.

## 9. Reproduction

```bash
npm run build
node scripts/token-levers-probe.mjs        # exit 0 = all lever gates pass
node scripts/token-breakeven-curve.mjs
```

Evidence: `benchmark-results/token-levers/latest/{results.json,summary.md}` and `benchmark-results/token-breakeven/latest/{results.json,summary.md}`.

The break-even harness needs `../living-context-driven-development` present for the LCDD row; it reports the corpus as skipped otherwise and the rest of the curve still runs.

## 10. References

- [`docs/future-plan/token-efficiency-strategy-v2.md`](../future-plan/token-efficiency-strategy-v2.md) — the strategy these measurements support
- [`docs/future-plan/token-efficiency-strategy.md`](../future-plan/token-efficiency-strategy.md) — v1, corrected by § 5 and § 6 above
- [`docs/experiments/nodenet-ab-lcdd-medium-benchmark-2026-08-09.md`](nodenet-ab-lcdd-medium-benchmark-2026-08-09.md) — the +47% medium-repo result reconciled in § 6
- [`docs/experiments/nodenet-cli-vs-mcp-token-comparison-2026-08-09.md`](nodenet-cli-vs-mcp-token-comparison-2026-08-09.md) — transport overhead, unchanged by this experiment
- [`docs/token-efficient-context.md`](../token-efficient-context.md) — budget policy and release gates
