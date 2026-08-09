# Token-Efficient Graph Context

## Decision

NodeNet will use its graph as a token-efficient retrieval layer without making
token reduction more important than correctness or governance. Agents should
retrieve a Minimum Sufficient Context (MSC) before broad repository searches,
then expand to source only when the graph evidence is insufficient.

The primary product metric is successful tasks per total agent token. Token
savings alone are not a success if task quality falls or a mandatory living
context is missed.

Code and supported repository documents are extracted locally. Media remains at
a deliberately safer boundary: files become non-authoritative candidates, and
a bounded adjacent `.nodenet.json` sidecar can supply `summary` and `concepts`
from an approved local or model-assisted pipeline. These concepts are inferred
retrieval evidence and cannot govern or block a change.

## What Graphify validates

Graphify demonstrates several useful patterns: query-first agent guidance,
budgeted graph traversal, incremental extraction caches, progressive graph
queries, query logging, outcome feedback, and reproducible token benchmarks.
Its published results also show that compression grows with corpus size and can
be negligible for small corpora.

NodeNet should not copy the workflow blindly. Reading a graph report, then a
large graph result, then the same raw files can use more tokens than direct
source inspection. NodeNet therefore budgets the returned MSC itself and keeps
governance evidence mandatory.

## Implemented retrieval path

The first implementation adds an automatic path: users run
`nodenet context <target>` or call MCP `context` with only `target`. NodeNet
applies its internal default without requiring configuration, matching
Graphify's `graphify query "..."` behavior. Budget flags are advanced overrides,
not part of the normal workflow.

It also adds:

- A model-neutral token estimate based on serialized bundle size.
- A soft `maxTokens` budget (default 2,000; range 256–32,000).
- Deterministic relevance ordering based on relation, provenance, and node kind.
- Bundle metrics: estimated and budgeted tokens, truncation, selected nodes,
  and omitted nodes.
- Optional MCP `context.maxTokens` and CLI `context --max-tokens` overrides for
  evaluation, unusually large targets, and constrained clients.
- A governance guarantee: living context, authority, ownership, boundaries, and
  guidance are retained even if required data exceeds the soft budget.
- Intent-aware `nodenet ask` retrieval and hypothetical `nodenet affected` analysis.
- File-level ranking with compact `primaryFiles`, deferred `supportingFiles`,
  and on-demand `expansionCandidates`.
- Progressive `--detail map|evidence|source` output with bounded,
  secret-scanned snippets.
- A bounded cache that never stores snippets or secret-flagged bundles.
- Local opt-in feedback that never mutates authority.
- An executable graded-relevance benchmark for primary/useful precision,
  essential/context recall, MRR, nDCG@10, and token reduction.

## Target architecture

### Zero-configuration default

The normal interface must remain:

```bash
nodenet context "createSettlement"
```

No token number is required. The library owns the default so CLI, MCP, and API
cannot drift. Advanced clients may override it, but product documentation and
agent guidance should teach the zero-configuration form first.

### Retrieval stages

1. Resolve the requested file or symbol and report ambiguity.
2. Return a compact map of important relationships and governance.
3. Return AST-bounded source evidence for selected nodes when requested.
4. Expand to multi-hop context only when confidence is insufficient.

### Ranking

Candidate scoring should combine intent match, relation weight, symbol kind,
provenance, graph distance, change proximity, governance relevance, community
affinity, uncertainty, and token cost. Every selected item should eventually
explain why it was included.

### Budget policy

Future retrieval should reserve portions of the budget for target identity,
source evidence, governance, and response metadata. Mandatory and hardened
contexts must never be removed merely to meet a token target. When required
evidence alone exceeds the budget, the result must report that explicitly.

### Source evidence

Source snippets should be selected on AST boundaries and include path, line
range, provenance, and estimated token cost. Whole files are not returned by
default. All final bundles remain secret-scanned and source text is treated as
evidence rather than instructions.

### Cache

Context results may be cached by graph version, normalized query, target,
budget, detail level, current diff, context registry version, and ranking
algorithm version. Cache entries must be bounded, atomically written, and
invalidated whenever their graph, ownership, governance, or diff input changes.
Secret-bearing results must not be cached.

### Agent integration

Installed instructions should require query-first behavior, prohibit reading
the complete graph or report for targeted questions, and recommend source reads
only from the returned file set. An optional strict-first-query mode may block
one broad read and then fall back gracefully if graph retrieval fails.

## Evaluation plan

Build a dataset of at least 30–50 explanation, dependency, bug-fix, cross-file,
API, impact, reviewer, and governed-change tasks. Compare raw source retrieval,
the original graph bundle, and budgeted retrieval.

Measure total input/output/tool tokens, files read, graph calls, relevant-file
precision and recall, living-context recall, latency, task success, test pass
rate, and governance violations. Break results down by repository size.

Initial release gates:

- Median token reduction of at least 30% on medium repositories.
- At least 50% on large repositories.
- No more than a 2% decrease in task success.
- 100% recall for mandatory living contexts.
- Zero governance violations.
- P95 cached context retrieval below 500 ms.

Claims about token savings must include end-to-end task tokens and quality, not
only a comparison between raw corpus size and serialized graph size.

> **Gate accounting caveat.** These gates are written against
> `metrics.estimatedTokens`, which serializes compactly while the CLI and MCP
> emit indent-2 JSON — a measured **+25%** undercount of the real payload. Until
> the estimator is corrected, evaluate gates against `emittedTokens` (now
> reported by `benchmark-retrieval`). See
> [`future-plan/token-efficiency-strategy-v2.md`](future-plan/token-efficiency-strategy-v2.md) § 3
> and [`experiments/nodenet-token-levers-2026-08-09.md`](experiments/nodenet-token-levers-2026-08-09.md).

## Delivery roadmap

1. **Measurement:** token estimates, bundle metrics, task dataset, evaluator.
2. **Budgeted retrieval:** hard input validation, deterministic ranking, and
   truncation reporting.
3. **Progressive evidence:** detail levels, ambiguity handling, AST snippets,
   and recommended next retrieval.
4. **Efficiency infrastructure:** versioned result cache, local opt-in logs, and
   feedback outcomes (`useful`, `dead-end`, `corrected`).
5. **Agent integration:** query-first instructions, optional one-shot strict
   guard, and graceful fallback.
6. **Production validation:** reproducible A/B benchmarks and published quality
   gates before marketing token-reduction claims.

## Definition of done

A production token-efficient MSC stays within its budget tolerance unless
mandatory evidence alone exceeds it, never truncates mandatory governance,
provides provenance and selection reasons, surfaces ambiguous targets, cannot
serve stale cache entries, remains secret-scanned, and meets the evaluation
gates above.
