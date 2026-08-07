# Change Impact

`nodenet impact [--base <ref>]` turns a git diff into an explainable impact
report (spec §12-15).

## Pipeline

1. **Diff** — safe `git diff` (arg arrays, validated refs).
2. **Symbol-level changes** — hunks are mapped to the *symbols* whose line
   ranges overlap; a change to `auth.ts` reports `refreshToken()`, not the
   whole file (spec §13). File-level changes (e.g. imports) are reported as
   `(file-level)`.
3. **Traversal** — from each changed symbol, walk callers/consumers/dependents
   with cycle-safe limits.
4. **Context** — living contexts whose `appliesTo` matches affected files.
5. **Ownership + boundaries** — owners of affected code; ownership-boundary
   crossings (e.g. Checkout Team change touching Payment Team code).
6. **Severity** — CRITICAL (hardened/mandatory context directly governing
   changed code) → HIGH (cross-team) → MEDIUM (governed code) → LOW (internal).

## Example (the NodeNet MVP, spec §72)

Checkout Team changes `CheckoutService`:

```
Impact: HIGH
Ownership boundary crossed: checkout-team → payment-team (via PaymentService)
Affected living context: PAYMENT-003 [ACTIVE] STANDARD, SEC-009 [ACTIVE] HARDENED
Review required: payment-team
Authority review: finance-team, security-team
```

Suppressions (`.nodenet/suppressions.json`) let teams document false positives
with reason, owner, createdAt and optional expiresAt (spec §60).

## See also

- What is being traversed → [graph.md](graph.md)
- How the impact report becomes reviewers → [review-governance.md](review-governance.md)
- How diffs are computed safely → [../../SECURITY.md](../../SECURITY.md)
- The reference scenario this example comes from → [../../README.md#the-problem](../../README.md#the-problem)
