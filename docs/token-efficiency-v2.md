# Token-efficient retrieval defaults

NodeNet retrieval uses compact, routing-first payloads by default.

## CLI

- `nodenet ask <question> --json` returns the lean routing shape. Add `--full`
  for matches, connections, expansion candidates, and ranking explanations.
- `nodenet context <target> --detail route --json` returns file routing,
  ownership, and mandatory governance without graph evidence.
- `--detail map` projects evidence to identity, path, relation, and direction.
- `--detail evidence` adds score, depth, and provenance; `source` additionally
  adds bounded source excerpts.
- JSON is compact by default. Add `--pretty` for human inspection.

Every JSON retrieval writes a private `.nodenet/token-log.jsonl` record with
the estimated emitted wire tokens. Estimates use compact UTF-8 bytes divided
by four; they are model-neutral estimates, not provider billing telemetry.

## Context accounting

`metrics` reports `emittedTokens`, `mandatoryTokens`, `budgetExceeded`,
`budgetExceededByMandatory`, and `budgetOverflowReason`. Mandatory governance
is never removed merely to satisfy a caller's soft budget.

## Compatibility

The default context wire shape no longer duplicates `codeEvidence[].label` in
`codeContext`, and no longer emits derivable `selectionReason` prose. Consumers
that need the v0.6 beta.1 shape during migration can request:

```bash
nodenet context <target> --json --compat v1
```

The compatibility projection is transitional and should not be placed in new
agent prompts. Full `ask` compatibility is available with `--full`.

MCP transports emit structured JSON once, through `structuredContent`; legacy
in-process callers retain text content during migration. `nodenet mcp` and
`nodenet serve` default to the `core` tool preset. Use `--tools governance` or
`--tools all` when the additional schemas are needed.

## Quality experiment

Run `npm run experiment:token-tasks`. The deterministic self-repository suite
contains ten labeled retrieval scenarios (seven holdouts), three real Git
mutation/governance scenarios, adversarial security tests, and historical
replay. It compares lean versus full routing and `route` versus `evidence`
mandatory-context recall. This establishes payload and deterministic retrieval
parity; it does not replace a provider-telemetry, model-in-the-loop A/B study.
