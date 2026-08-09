# NodeNet Self-Repository E2E — 2026-08-09

## Why this test exists

The earlier controlled benchmark proved deterministic contracts but did not
prove that NodeNet could understand and govern its own non-trivial codebase.
This E2E suite dogfoods the complete workflow against NodeNet source code:

```text
build → ask → context → isolated Git mutation → impact → reviewers
      → adversarial MCP/security → historical replay → HTML evidence
```

Run it with:

```bash
npm run build
npm run test:e2e:self
```

The runner is [scripts/e2e-self.mjs](../scripts/e2e-self.mjs). It creates
temporary Git repositories for mutations and deletes them after evaluation; it
does not modify the active branch. Machine-readable labels live in
[e2e/scenarios.json](../e2e/scenarios.json).

## Governance overlay for NodeNet itself

The repository now declares authoritative ownership in `nodenet.config.json`
and three LCDD contexts:

- `NN-LANG-001`: parser compatibility, owned/approved by `language-team`.
- `NN-SEC-001`: hardened MCP/security boundary, owned/approved by
  `security-team` and enforced as `block`.
- `NN-GOV-001`: governance decision quality, owned/approved by
  `governance-team`.

The latest self-build contains 1,099 nodes, 1,810 edges, and three active contexts.

## Retrieval results on real NodeNet code

The evaluation now uses graded relevance and a tiered result contract:
`primaryFiles`, `supportingFiles`, and `expansionCandidates`. Only the compact
primary set is read initially and counted for strict precision.

| Split | Cases | Primary precision | Essential recall | Useful precision | Context recall | MRR | nDCG@10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Training | 3 | 100% | 100% | 100% | 100% | 1.0 | 0.9752 |
| Internal holdout | 7 | 100% | 100% | 100% | 100% | 1.0 | 0.9562 |
| Overall | 10 | 100% | 100% | 100% | 100% | 1.0 | 0.9619 |

The ranking operates at file level: camel-case-aware phrase matches and domain
directories are rewarded, central nodes and unsolicited test/script files are
penalized, and repeated symbols in one file receive only a small aggregation
bonus. A confidence margin selects one or two primary files; supporting and
expansion candidates remain available without consuming the initial read set.

The seven-case holdout is an internal development holdout, not a blind external
benchmark. Labels and query wording were reviewed during development, so these
results prove regression behavior on this repository, not cross-repository
generalization. The next credible gate is a frozen, independently labeled
external corpus.

## Isolated real-code mutation results

The harness makes and commits an actual exported-symbol change to parser, MCP
security, and governance-evaluation source files. All three changes detected the
changed file, required context, and required authority reviewer.

| Scenario | Severity | Blast files | Approval-context precision | Required-reviewer precision | Precision gate |
| --- | --- | ---: | ---: | ---: | --- |
| Parser change | HIGH | 107 | 100% | 100% | PASS |
| MCP security change | CRITICAL | 108 | 100% | 100% | PASS |
| Governance change | HIGH | 108 | 100% | 100% | PASS |

Reviewer routing now uses a separate approval radius: changed files plus
one-hop code dependencies. Direct ownership/CODEOWNERS and contexts matching
that radius may become required; contexts and owners reached only through the
broader traversal are emitted as `informational` with score `0.2`. Required and
authority reviewers carry direct evidence scores (`0.85` and `1.0`). This
reduces each internal mutation from three required authority teams to exactly
the manually labeled team while preserving transitive visibility.

The broad blast radius is still 107–108 files and still reaches all three
contexts. It no longer creates notification fatigue, but remains an impact
precision weakness. The dashboard therefore retains a blast-radius warning
separate from the passing reviewer-precision gate.

## Security, stale state, and historical replay

The E2E runner executes the adversarial security/property/MCP HTTP suites: 21
tests passed. It also executes the startup-platform historical replay suite,
which creates an isolated Git worktree and replays an exact base/head pair: six
tests passed.

The dogfood run found and fixed one additional production bug: an explicit path
such as `src/parser/polyglot.ts` could be displaced by a fuzzy callable match
sharing generic path tokens. Explicit file paths now resolve before fuzzy symbol
ranking, with a regression test.

## Deterministic A/B pilot

Variant A estimates a broad read over authored code/docs/configuration; Variant
B uses `ask` plus bounded context. For ten tasks:

- A: 272,590 estimated tokens per broad corpus read.
- B: 15,020 estimated tokens total across ten scoped contexts.
- Estimated reduction: 99.45%, with ten of ten retrieval gates passing.

This number is a ceiling-style deterministic comparison, not an LLM experiment.
It assumes A reads the complete authored corpus and does not include actual model
token telemetry, edit success, or repeated trials. It must not be presented as a
general agent productivity claim.

## Generated evidence

The reproducible output is written under `benchmark-results/e2e/latest/`:

- `results.json`: case-level raw metrics and selected files.
- `summary.md`: compact result summary.
- `index.html`: standalone responsive dashboard.
- `repository-graph.html`: full interactive NodeNet graph generated by NodeNet.

## Next quality gates

Before claiming production-grade precision:

1. Reduce real-code affected-file median below 50 for these labeled changes.
2. Validate the 100% internal reviewer/context precision on frozen historical
   and external holdouts without reducing mandatory-authority recall.
3. Freeze an external holdout and expand to at least 30 real retrieval questions and 30 historical diffs,
   including `pass`, `warn`, and `block` distributions.
4. Add repeated model-based A/B tasks with frozen prompts, hidden acceptance
   tests, identical model/version, and provider token telemetry.
