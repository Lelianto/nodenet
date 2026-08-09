# NodeNet token-lever probe

Generated: 2026-08-09T14:54:29.900Z
Graph: 1103 nodes, 1820 edges
Estimator: bytes / 4 (same estimator as src/ai/context-builder.ts estimateTokens)

## Context bundle levers (tokens)

| Target | Evidence | Pretty (emitted) | Compact | Tier 1 lean | Tier 1 saving | Profile map | Profile route |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `buildContextBundle` | 19 | 2464 | 2008 | 1312 | 34.6% | 1117 | 124 |
| `askGraph` | 20 | 2383 | 1907 | 1228 | 35.6% | 1024 | 117 |
| `attachRepositoryArtifacts` | 10 | 1408 | 1119 | 774 | 30.9% | 669 | 185 |
| `authorityRank` | 8 | 1178 | 959 | 658 | 31.4% | 574 | 123 |
| `loadConfig` | 19 | 2283 | 1831 | 1183 | 35.4% | 990 | 118 |
| `adaptLcddContext` | 10 | 1308 | 1048 | 702 | 33.1% | 598 | 119 |
| `scoreBenchmark` | 9 | 1353 | 1079 | 756 | 30.0% | 661 | 192 |
| `analyzeImpact` | 6 | 980 | 769 | 558 | 27.5% | 493 | 186 |
| `resolveReviewers` | 5 | 860 | 671 | 499 | 25.8% | 444 | 189 |
| `secureToolOutput` | 17 | 2176 | 1736 | 1151 | 33.7% | 978 | 194 |
| `buildGovernanceDecision` | 9 | 1412 | 1136 | 797 | 29.9% | 703 | 193 |
| `estimateTokens` | 18 | 2378 | 1942 | 1277 | 34.3% | 1094 | 123 |

Tier 1 = compact JSON minus `codeContext` (duplicate of `codeEvidence[].label`) minus `selectionReason` (derivable prose).

- Median Tier 1 saving vs compact: **32.2%** (range 25.8%–35.6%).
- Cases at or above 25% saving: **12/12**.
- Median pretty-to-compact saving: 19.9%.
- Median reported `estimatedTokens` 1127 vs median emitted 1410 tokens.
- Median profile saving: map 41.6%, route 88.0% (route median 154.5 tokens).
- Cases where the soft budget was exceeded: 1/12.
- Cases where Tier 1 is provably lossless: 12/12.

## Ask payload levers (tokens)

| Question | Matches/Connections | Pretty (emitted) | Compact | Lean | Lean saving | matches+connections share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| how is the context bundle budget applied | 30/33 | 5620 | 4292 | 88 | 98.0% | 76.5% |
| who reviews a governance change | 30/28 | 5525 | 4231 | 135 | 96.8% | 71.2% |
| how are living contexts loaded from disk | 30/24 | 4924 | 3731 | 93 | 97.5% | 73.1% |
| where is the MCP output secret scan | 30/28 | 5212 | 3907 | 103 | 97.4% | 73.7% |

- Median lean saving vs compact: **97.5%** (median 98 tokens vs 5368.5 emitted).
- Median `matches` + `connections` share of the payload: 73.4%.
- Cases where the lean projection preserves `recommendedFiles`: 4/4.

## Gates

| Gate | Requirement | Result |
| --- | --- | --- |
| `tier1-breadth` | Tier 1 saves >= 25% of compact bytes on >= 10 of 12 context targets | PASS |
| `tier1-lossless` | codeContext duplicates evidence labels and selectionReason is derivable on every case | PASS |
| `ask-lean` | Lean ask projection saves >= 90% of compact bytes (median) | PASS |
| `ask-lean-lossless` | Lean ask projection preserves recommendedFiles on every case | PASS |
| `estimator-undercount` | Reported estimatedTokens under-counts the emitted payload (documents the accounting bug) | PASS |

Overall: **PASS**

## Reproduction

```bash
npm run build
node scripts/token-levers-probe.mjs
```

Case-level evidence: `benchmark-results/token-levers/latest/results.json`.
