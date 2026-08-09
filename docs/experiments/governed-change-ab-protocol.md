# Governed Change A/B Protocol

## Objective

Test whether NodeNet improves **safe-change efficiency** for AI coding agents:
task success and governance correctness first, then tokens, time, and rework.
This protocol does not use raw-corpus compression as a proxy for task value.

## Hypotheses

- **H1 — Quality non-inferiority:** treatment task success is no more than two
  percentage points below control.
- **H2 — Governance superiority:** treatment mandatory-context and required-
  reviewer recall are 100%, with zero forbidden-change violations.
- **H3 — Exploration efficiency:** treatment reads fewer irrelevant files and
  uses fewer exploration tokens.
- **H4 — Operational efficiency:** treatment reduces median completion time or
  rework turns without increasing total tokens materially.

Token reduction is a positive secondary outcome, not a prerequisite for H1–H3.

## Conditions

| Control | Treatment |
| --- | --- |
| Normal repository tools: list, search, read, edit, tests | Same tools plus NodeNet |
| No graph or generated NodeNet artifacts | Query-first: lean `ask`, then `route`; `evidence` only when needed |
| Repository instructions remain active | Same instructions and model configuration |

Both conditions use the same model/version, system prompt, context-window size,
temperature, repository commit, dependency state, and frozen task text. Indexing
cost is reported separately and both cold and amortized treatment costs are
shown.

## Design

- At least **10 paired tasks**, preferably 20 or more.
- Use identical tasks on independently reset worktrees. Do not use merely
  “similar difficulty” tasks as the primary comparison.
- Randomize condition order and counterbalance it across tasks.
- Split tasks across direct-symbol, cross-module, ownership-boundary,
  hardened-context, ambiguous-search, and regression-sensitive strata.
- Write hidden acceptance tests and expected governance labels before any run.
- Start each run in a fresh agent session. Do not let author knowledge pass
  between conditions.
- Preserve raw tool events and provider usage telemetry.

## Required measurements

Per run record:

- task and regression success;
- provider input, cached-input, and output tokens;
- NodeNet indexing tokens/cost, if any;
- elapsed time and tool-call count;
- files read, irrelevant files read, and source bytes read;
- implementation and repair turns;
- mandatory-context recall;
- required-reviewer precision and recall;
- severity correctness;
- forbidden-change and governance-violation count.

Report three token views:

1. **Task tokens:** everything consumed during the task, excluding indexing.
2. **Cold total:** task tokens plus the complete indexing cost.
3. **Amortized total:** task tokens plus indexing cost divided by observed reuse.

## Release gates

All safety and quality gates are blocking:

| Gate | Requirement |
| --- | --- |
| Paired sample | at least 10 complete task pairs |
| Task success | treatment decrease no worse than 2 percentage points |
| Mandatory-context recall | 100% |
| Required-reviewer recall | 100% on labeled approval tasks |
| Forbidden changes | zero |
| Governance violations | zero |
| Irrelevant-file reads | treatment median no worse than control |
| Total task tokens | report honestly; no blocking reduction target yet |

A public token-saving claim additionally requires treatment median provider
task tokens below control with a bootstrap 95% confidence interval that does
not cross zero. Until then, use “bounded context” and “reduced exploration
waste,” not “saves tokens.”

## Running and scoring

Record completed pairs using
[`examples/governed-change-ab.template.json`](../../examples/governed-change-ab.template.json),
then run:

```bash
node scripts/score-governed-change-ab.mjs path/to/results.json
```

The scorer refuses a publishable verdict below ten complete pairs and writes a
machine-readable summary to stdout.
