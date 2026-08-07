# Review Governance

NodeNet optimizes for **high signal, not maximum notifications** (spec §58).

## Severity → policy (configurable in `nodenet.config.json`)

| Severity | Default policy |
| --- | --- |
| LOW | informational |
| MEDIUM | comment |
| HIGH | request review |
| CRITICAL | require approval (potential merge block — repository-policy controlled, spec §59) |

## Reviewer resolution (`nodenet reviewers`)

Returns `{ suggested, required, authorityRequired }` with **explainable
reasons** (spec §18-19):

- ownership (declared → required; git-history inference → suggested only)
- CODEOWNERS (authoritative → required)
- context authority (approvedBy → authorityRequired; hardened owners →
  authorityRequired)

Every reviewer is deduplicated across sources with all reasons attached — a
team appearing via CODEOWNERS, ownership and context approval is mentioned
once.

## Example

```
Required:
  payment-team
    because: src/payment/PaymentService.ts is owned by payment-team (source: nodenet, confidence: authoritative)
    because: PAYMENT-003 (STANDARD) is owned by payment-team

Authority approval required:
  finance-team
    because: PAYMENT-003 requires approval from finance-team (PAYMENT-003 ... is STANDARD, status ACTIVE)
```

NodeNet never assumes authority to block merges; enforcement is opt-in via
repository policy (spec §17).

## See also

- Where ownership-based reviewers come from → [ownership.md](ownership.md)
- Where authority-based approvers come from → [authority.md](authority.md)
- The impact report this consumes → [change-impact.md](change-impact.md)
- Configuring the severity → action policy → [../../README.md#configuration](../../README.md#configuration)
