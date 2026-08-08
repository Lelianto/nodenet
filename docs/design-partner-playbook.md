# Design-partner pilot playbook

Target three regulated SaaS or fintech teams with 20–150 engineers, GitHub,
CODEOWNERS, shared/sensitive services, and active adoption of coding agents.
Start in `observe`, move to `warn`, and only enable `enforce` after reviewing
the labeled results with the responsible owners.

## Four-week pilot

1. **Week 0 — activate:** run `nodenet bootstrap --github`, adapt the sample
   LCDD policy, build the graph, and reach a useful decision within 15 minutes.
2. **Week 1 — observe:** label every sampled decision as correct, false
   positive, missed impact, or wrong reviewer. Do not block merges.
3. **Week 2 — warn:** route declared reviewers and discuss high/critical
   evidence paths in the existing PR workflow.
4. **Weeks 3–4 — enforce narrowly:** block only validated hardened paths. Audit
   every override with actor, reason, and expiry.

## Weekly review

- Governed changes and active repositories.
- Reviewer precision/recall and outcome accuracy.
- False blocks and missed hardened impacts.
- p50/p95 analysis time and first-decision activation time.
- Overrides grouped by reason and expiry.
- Contexts with missing owner, stale review, or orphaned scope.
- Qualitative feedback: correct, false positive, missed impact, wrong reviewer.

## Validation gate

Do not build the organization control plane merely from feature interest.
Proceed when three partners use the governance loop weekly and at least two
commit to a paid pilot with agreed accuracy, latency, and activation targets.
Only then prioritize organization installation, multi-repository governance,
centralized Contexts, identity mapping, evidence history, signed audit export,
rollout controls, notifications, and billing.
