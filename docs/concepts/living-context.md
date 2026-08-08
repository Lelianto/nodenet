# Living Context

NodeNet follows **Living Context Driven Development** (LCDD): context is a
first-class, versioned, machine-readable governance artifact — not a comment, a
ticket, or a Slack message.

## The artifact

Each Context in `.lcdd/contexts/**/*.yaml` uses the canonical LCDD 0.6.0
Context Schema and is validated by `@lcdd/core@0.6.0`:

- `id`, `version`, `title`, `description`
- `category` — business rule, architecture decision, security policy, ...
- `lifecycle` — the lifecycle stage
- `authority.source` + `authority.level` — who establishes the constraint and
  how hard it is to change
- `governance.classification` — LCDD "governance by rate of change"
  (`hardened-mandate` → `hardened-local`, `local-experimental`)
- `applies_to` — which code it governs (globs)
- `owner` + `governance.approvers` — who governs it and who must approve changes
- `source`, `evidence`, and trust metadata — provenance and authority evidence
- `enforcement.mode` — `block`, `warn`, `comment`, or `silent`

Inference is never silently promoted to fact (spec §7).

## Lifecycle (spec §6)

```
draft → candidate → approved → active → deprecated → archived
```

LCDD owns canonical lifecycle transitions. NodeNet may derive a `NEEDS_REVIEW`
health condition for stale Contexts, but it does not write that condition as a
new LCDD lifecycle stage.

## Conflicting changes

A code change that conflicts with an ACTIVE hardened context is never applied
silently. NodeNet reports the conflict and proposes a **Context Change Proposal**
(`nodenet context propose <id>`) which requires review and approval (spec §23-24).

## See also

- How authority levels gate changes to context → [authority.md](authority.md)
- Who owns and approves context → [ownership.md](ownership.md)
- The `nodenet health` command and CLI reference → [../../README.md#cli-reference](../../README.md#cli-reference)
- Why context files are runtime-validated → [../adr/002-runtime-validation.md](../adr/002-runtime-validation.md)
