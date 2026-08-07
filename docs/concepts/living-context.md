# Living Context

NodeNet follows **Living Context Driven Development** (LCDD): context is a
first-class, versioned, machine-readable governance artifact — not a comment, a
ticket, or a Slack message.

## The artifact

Each context in `.nodenet/context.json` mirrors the LCDD Context Schema:

- `id`, `version`, `title`, `description`
- `type` — business rule, architecture decision, security policy, ...
- `status` — the lifecycle stage
- `authority` — how hard it is to change
- `governanceClassification` — LCDD "governance by rate of change"
  (`hardened-mandate` → `hardened-local`, `local-experimental`)
- `appliesTo` — which code it governs (globs)
- `owner` + `approvedBy` — who governs it and who must approve changes
- `provenance` — source, sourcePath, createdBy, createdAt, lastReviewedAt,
  kind (FACT / INFERRED / DISCOVERED / USER_DECLARED / EXTERNAL / AI_PROPOSED),
  evidence

Inference is never silently promoted to fact (spec §7).

## Lifecycle (spec §6)

```
DRAFT → CANDIDATE → APPROVED → ACTIVE → DEPRECATED → ARCHIVED
                          ACTIVE → NEEDS_REVIEW → ACTIVE | DEPRECATED
```

Transitions are validated; `ACTIVE → DRAFT` fails unless `--force` (audited).
Decay moves stale `ACTIVE` contexts to `NEEDS_REVIEW` — it never deletes or
disables them (spec §26).

## Conflicting changes

A code change that conflicts with an ACTIVE hardened context is never applied
silently. NodeNet reports the conflict and proposes a **Context Change Proposal**
(`nodenet context propose <id>`) which requires review and approval (spec §23-24).

## See also

- How authority levels gate changes to context → [authority.md](authority.md)
- Who owns and approves context → [ownership.md](ownership.md)
- The `nodenet health` command and CLI reference → [../../README.md#cli-reference](../../README.md#cli-reference)
- Why context files are runtime-validated → [../adr/002-runtime-validation.md](../adr/002-runtime-validation.md)
