# NodeNet token break-even curve

Generated: 2026-08-09T14:47:48.757Z
Estimator: bytes / 4 (same estimator as src/ai/context-builder.ts estimateTokens)
Targets per corpus: 5 highest-degree code symbols (deterministic selection). All figures are medians.

## Curve

| Corpus | Graph nodes | Authored files | Grepped read | Best-case read | NodeNet default (emitted) | Tier 1 lean | Profile route |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Fixture: monorepo | 14 | 5 | 60 | 27 | 609  | 353  | 101  |
| Fixture: basic TypeScript | 18 | 4 | 68 | 68 | 544  | 303  | 93  |
| Example: payments demo | 52 | 16 | 943 | 105 | 1925  | 1094  | 213 **WIN** |
| Self subset: core types + context | 159 | 22 | 4885 | 2626 | 1680 **WIN+** | 896 **WIN+** | 119 **WIN+** |
| Self subset: + ai + parser | 312 | 33 | 5076 | 3879 | 2383 **WIN+** | 1228 **WIN+** | 120 **WIN+** |
| Self subset: + graph + governance | 538 | 55 | 6758 | 2816 | 2418 **WIN+** | 1252 **WIN+** | 117 **WIN+** |
| NodeNet self-repository | 1170 | 209 | 8887 | 8887 | 2225 **WIN+** | 1200 **WIN+** | 117 **WIN+** |
| LCDD specification + implementation | 1236 | 187 | 18990 | 8404 | 2222 **WIN+** | 1389 **WIN+** | 135 **WIN+** |

`WIN` marks a variant costing fewer tokens than the grepped-read baseline for the same target.
`WIN+` marks a variant that also beats the strict best-case baseline (a perfect-luck agent that opens only the defining file).

- Baseline `grepped read` = sum of bytes of every authored file containing the target identifier — the cost of reading each grep candidate.
- Baseline `best-case read` = bytes of the single file that defines the target — a perfect-luck unaided agent.

## Break-even

Against the grepped-read baseline (an agent that opens every grep candidate):

| Variant | Wins from | Detail |
| --- | --- | --- |
| Default (emitted) | 159 nodes | between 52 and 159 graph nodes |
| Tier 1 lean | 159 nodes | between 52 and 159 graph nodes |
| Profile route | 52 nodes | between 18 and 52 graph nodes |

Against the strict best-case baseline (an agent that somehow opens only the defining file):

| Variant | Wins from | Detail |
| --- | --- | --- |
| Default (emitted) | 159 nodes | between 52 and 159 graph nodes |
| Tier 1 lean | 159 nodes | between 52 and 159 graph nodes |
| Profile route | 159 nodes | between 52 and 159 graph nodes |

## Skipped corpora

- fixture-react-app: no code symbols eligible as targets

## Reproduction

```bash
npm run build
node scripts/token-breakeven-curve.mjs
```

Case-level evidence: `benchmark-results/token-breakeven/latest/results.json`.
