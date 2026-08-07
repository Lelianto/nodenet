# Ownership

Ownership is first-class (spec §9): files/directories/packages are `owned_by`
teams or developers, and **code ownership is not the same as context authority**.

> Payment Team may own `PaymentService.ts`, but Finance Team has authority over
> `PAYMENT-003` (the settlement rule). Payment Team can change the
> implementation; Finance Team must approve changes that affect settlement
> semantics.

## Sources and ranking (spec §10)

| Source | Authority |
| --- | --- |
| LCDD context metadata | highest |
| NodeNet explicit ownership (`.nodenet/ownership.json`, config overrides) | high |
| CODEOWNERS | authoritative |
| Git history | **suggestions only** — "likely reviewer", never required |

## Confidence (spec §11)

`AUTHORITATIVE` / `DECLARED` / `INFERRED` / `UNKNOWN` — no fake numeric
precision. Confidence and source decide whether a reviewer is *required* or
merely *suggested*.

## Commands

- `nodenet owner <path-or-symbol>`
- `nodenet reviewers` — reviewer resolution for the current change

## See also

- Why ownership is not authority → [authority.md](authority.md)
- How context carries its own owner/approvers → [living-context.md](living-context.md)
- How ownership becomes a review requirement → [review-governance.md](review-governance.md)
- Configuration of teams and overrides → [../../README.md#configuration](../../README.md#configuration)
