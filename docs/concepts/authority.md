# Authority

Authority answers: **who says this is a rule, and how hard is it to change?**
(spec §8, LCDD "governance by rate of change").

## Levels

| Level | Meaning | Reviewer effect |
| --- | --- | --- |
| INFORMATIONAL | no enforcement | none |
| GUIDELINE | should be followed | suggestion |
| STANDARD | must be followed | reviewer required on impact |
| HARDENED | immutable to AI; human approval | authority approval required |
| MANDATORY | regulatory/blocking | authority approval, possible merge block |

HARDENED and MANDATORY contexts are **immutable to AI agents** (LCDD
principle): they can only change through an explicit, human-approved Context
Change Proposal.

## Mapping from LCDD classifications

`hardened-mandate` → MANDATORY, `hardened-standard` → HARDENED,
`hardened-local` / `local-standard` → STANDARD, `local-guideline` → GUIDELINE,
`local-experimental` → INFORMATIONAL.

For canonical LCDD 0.6 Contexts, `authority.level` maps directly from `0`–`4`
to INFORMATIONAL–MANDATORY. Classification remains a separate governance
dimension, and merge behavior follows `enforcement.mode`, active lifecycle,
and approval requirements.

## Human > AI (spec §22)

AI agents can DISCOVER, ANALYZE, EXPLAIN, RECOMMEND, PROPOSE. They must not
automatically APPROVE_HARDENED_CONTEXT, CHANGE_AUTHORITY, CHANGE_OWNERSHIP,
DELETE_MANDATORY_CONTEXT, or BYPASS_REQUIRED_REVIEW — unless explicit
repository policy permits a specific operation.

## See also

- Where authority comes from (LCDD classifications) → [living-context.md](living-context.md)
- How authority levels drive reviewer requirements → [review-governance.md](review-governance.md)
- How authority is carried on graph nodes → [graph.md](graph.md)
