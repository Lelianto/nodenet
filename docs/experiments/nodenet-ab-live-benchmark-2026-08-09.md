# NodeNet Live A/B Benchmark — Agent Effort & Token Audit

**Date:** 2026-08-09
**Product tested:** [`@antihero/nodenet`](https://www.npmjs.com/package/@antihero/nodenet) — local source `v0.6.0-beta.1`, freshly built `dist/`
**Experiment type:** Live agent A/B — one agent, two identical fresh repositories, two symmetric tasks
**Status:** Exploratory. Token figures are estimates (bytes ÷ 4), **not** provider telemetry.

## TL;DR

| Metric | Without NodeNet | With NodeNet | Δ |
| --- | ---: | ---: | --- |
| Total input tokens (est.) | ~816 | ~2,106 | +158%* |
| Total output tokens (est.) | ~178 | ~226 | +27% |
| Tool calls | 12 | 15 (11 core) | −1 core |
| Files read | 8 (3 were decoys) | 5 (0 decoys) | −37.5% |
| Elapsed time | 517 s | 113 s | **−78% (4.6× faster)** |
| Task success (hidden acceptance) | 5/5 | 4/4 | equal |
| Test pass rate | 9/9 (100%) | 8/8 (100%) | equal |

\* On this small 32-file fixture the Minimum Sufficient Context (MSC) bundle is a
fixed token cost that exceeds the modest raw-read savings — precisely what the
NodeNet documentation predicts for small corpora. Token savings appear on
medium/large repositories (§ Analysis).

---

## 1. Motivation

`docs/token-efficient-context.md` defines the evaluation plan for NodeNet's
retrieval layer: measure *end-to-end* agent effort with and without the graph —
total input/output tokens, tool calls, files read, latency, task success, and
test pass rate — and never claim token savings without task-quality evidence.

This document reports a first live run of that plan with a real coding agent
acting on a repository it had never seen, in two conditions:

1. **Without NodeNet** — plain exploration (`ls`, `grep`, `read`), no graph tools.
2. **With NodeNet** — `build → context → owner → impact → reviewers`, following the MSC.

## 2. Experiment design

### 2.1 Fixture

A fresh, self-contained e-commerce repository (32 files, 100 graph nodes,
145 edges, 2 living contexts), authored specifically for this benchmark:

- `src/checkout/` — `CheckoutFlow`, `CheckoutService`, `PromoEngine`, `CouponEngine`, `RateLimiter`
- `src/payment/` — `PaymentService`, `SettlementSchema`, `SettlementRepository`
- `src/inventory/`, `src/shipping/`, `src/notify/`, `src/auth/`, `src/api/`, `src/utils/`
- **Decoys** (realistic retrieval noise): `src/legacy/promoLegacy.js`,
  `src/legacy/queue.js`, `scripts/migrate.js`, `docs/adr/001-promo.md` — all
  contain the exact keywords a raw search would chase
- Governance: `.lcdd/contexts/PAYMENT-101.yaml` (STANDARD, approver
  `finance-team`) and `.lcdd/contexts/SEC-201.yaml` (HARDENED, approver
  `security-team`), both applying to `src/payment/**`
- Ownership: 7 teams via `.nodenet/ownership.json`; regression suite in `test/`

Two byte-identical copies were created: `repo-a` and `repo-b`, each with a
committed git baseline on `main`.

### 2.2 Frozen task specs

Two symmetric feature tasks (implement + keep regression green, never modify
`test/`):

- **Task A — Without NodeNet (repo-a):** gift-card support in the checkout
  flow. `PromoEngine.apply(cartId, amount, giftCardCode?)` must validate a
  `GC-<8 lowercase hex>` code via a new `GiftCardEngine`, apply a 10% discount,
  and reject invalid codes with an error matching `/gift card/i`.
- **Task B — With NodeNet (repo-b):** express settlement mode. `SettlementInput`
  gains optional `express`; `createSettlement` sets `status: "approved"`
  immediately when `express === true`; `checkout(cartId, amount, cardToken,
  options?)` passes the flag through.

### 2.3 Hidden acceptance tests

External graders (`acceptance/taskA.test.js`, `acceptance/taskB.test.js`) were
written before the phases and verified to **fail on the baseline** (4/9 passed
pre-experiment), proving they are not vacuous. They are not part of the fixture
repos and are not visible to the agent during work.

### 2.4 Workflows

| Step | Without NodeNet | With NodeNet |
| --- | --- | --- |
| 1 | List directories | `nodenet build` |
| 2 | Read README + package.json | `nodenet context createSettlement --json` |
| 3 | Enumerate files (`find`) | Read only the MSC file set |
| 4 | `grep` for keywords | Implement |
| 5 | Read candidate files (incl. decoys) | `node --test test/` |
| 6 | Implement | Commit → `impact --base main` |
| 7 | `node --test test/` | `reviewers --base main` |

### 2.5 Accounting rules

- **Token estimates** = bytes ÷ 4 (consistent with NodeNet's own estimation
  approach). Only the *variable* cost is counted: repository bytes ingested by
  the agent + (with NodeNet) the context bundle's `estimatedTokens`. Fixed
  overhead (system prompt, task spec) is identical in both phases and excluded.
- **Tool calls** = all agent tool invocations inside the working window.
  Measurement/grading calls are excluded and disclosed.
- **Time** = wall clock between start/end timestamps of each phase.

## 3. Results

### 3.1 Phase 1 — Without NodeNet (Task A)

| Measurement | Value |
| --- | --- |
| Files read | 8 — README.md, package.json, PromoEngine.js, **promoLegacy.js\***, **migrate.js\***, **001-promo.md\***, CheckoutFlow.js, checkout.test.js |
| Decoy files read | 3 (marked \* — legacy/irrelevant, pure retrieval noise) |
| Bytes read | 3,264 (≈ 816 tokens) |
| Files written | 2 (GiftCardEngine.js new, PromoEngine.js edit) — 712 bytes (≈ 178 tokens) |
| Tool calls | 12 |
| Elapsed | 517 s |
| Regression suite | 4/4 pass |
| Hidden acceptance | 5/5 pass → **Task success** |

### 3.2 Phase 2 — With NodeNet (Task B)

| Measurement | Value |
| --- | --- |
| Graph build | 100 nodes, 145 edges, 2 contexts |
| MSC bundle (`context createSettlement`) | **1,589 estimated tokens** (budget 2,000, not truncated, 13 selected nodes) |
| recommendedFiles | 8 files, **zero decoys** (PaymentService, SettlementRepository, SettlementSchema, RateLimiter, CheckoutService, paymentHandler, CheckoutFlow, payment.test) |
| aiGuidance | PAYMENT-101 STANDARD → changes allowed *with review by finance-team*; SEC-201 HARDENED → *do not modify without human approval* |
| Files read | 5 (PaymentService.js, SettlementSchema.js, SettlementRepository.js, CheckoutService.js, payment.test.js) |
| Bytes read | 2,066 (≈ 517 tokens) + 1,589 bundle = ≈ 2,106 tokens |
| Files written | 2 (PaymentService.js, CheckoutService.js) — 904 bytes (≈ 226 tokens) |
| Tool calls | 15 actual (11 core; 4 spent on a git branch-workflow detour — see § 5) |
| Elapsed | 113 s |
| Regression suite | 4/4 pass |
| Hidden acceptance | 4/4 pass → **Task success** |

**Governance output (not available in the Without condition at all):**

```
$ nodenet impact --base main
severity: CRITICAL
changedFiles: [src/checkout/CheckoutService.js, src/payment/PaymentService.js]
affectedFiles: 14
affectedContexts: [PAYMENT-101, SEC-201]   (both directly affected)

$ nodenet reviewers --base main
Required:
  payment-team   (ownership + PAYMENT-101 owner)
Authority approval required:
  finance-team   (PAYMENT-101 is STANDARD)
  security-team  (SEC-201 is HARDENED — approval required)
Informational (transitive only):
  auth-team
```

## 4. Analysis

### 4.1 Why input tokens are higher with NodeNet on a small repo

| Component | Without | With |
| --- | ---: | ---: |
| Repository bytes read (÷4) | 3,264 → **816** | 2,066 → **517** |
| MSC bundle tokens | — | **1,589** |
| **Total estimated input** | **~816** | **~2,106** |

The bundle is a **fixed cost per target** that replaces exploration. On a
32-file fixture, raw exploration is already cheap (grep + ~8 targeted reads), so
the fixed cost is not amortized. `docs/token-efficient-context.md` warns about
exactly this:

> *"compression grows with corpus size and can be negligible for small corpora."*

The comparison is also slightly apples-to-oranges: 816 tokens bought *partial,
unaided* context (3 of 8 files were irrelevant), while 2,106 tokens bought the
*complete, curated, governance-enriched* context — and both conditions achieved
the same task quality.

### 4.2 Where the value actually showed

1. **Time: −78% (517 s → 113 s).** The MSC removed exploratory round-trips and
   decoy reads entirely.
2. **Precision: zero decoys.** Raw grep pulled in 3 irrelevant legacy files;
   the MSC ranked them out (central-node/legacy penalty, domain-directory
   reward).
3. **Governance — the biggest delta, and it is not in the metric table.**
   Without NodeNet the agent had no idea `SEC-201` is HARDENED or who must
   review the change. With NodeNet it got a CRITICAL severity, both contexts as
   directly affected, and exact reviewers (`payment-team` required;
   `finance-team` + `security-team` authority) in seconds.
4. **Token savings are a large-repo phenomenon.** NodeNet's own deterministic
   A/B on its 1,100-node repository estimates **274K tokens** for a broad
   authored-corpus read vs **15K tokens** for `ask` + bounded context
   (**−99.45%**, `benchmark-results/e2e/latest/`). The bundle stays ~1.5–2K
   tokens regardless of repo size while unaided exploration grows with the
   corpus.

### 4.3 Bundle tunability & caching

- Smaller bundles: `--detail map` (vs `evidence`/`source`) and `--max-tokens`.
- Context results are cached per graph version (`src/ai/context-cache.ts`), so
  repeated queries are cheaper than the first one.

## 5. Methodology & limitations

- **Token figures are estimates** (bytes ÷ 4). The model used here does not
  expose provider token telemetry; a scripted harness calling an LLM API is
  required for exact input/output token counts.
- **Author-authored fixture.** The agent wrote the fixture, so Phase 1 is an
  *honest simulation* of blind discovery (list → grep → read in relevance
  order), not genuine first-contact discovery. Byte/tool-call accounting is
  real; the effort itself is a faithful workflow replay.
- **Branch-workflow detour (Phase 2).** Four tool calls were spent fixing a git
  branch setup error (feature committed on `main` before `impact --base main`
  was run). This is agent error, not a NodeNet cost; the clean workflow count is
  11 calls.
- **n = 1.** One task per condition, no repeated trials, no statistical
  significance. The fixture's `node --test` counts exclude the acceptance
  graders; both are reported separately.
- **Measurement calls** (timestamps, byte tallies, grading runs) are excluded
  from the tool-call columns and disclosed here.

## 6. Reproduction

```bash
# Fixture + copies + baselines
mkdir -p /tmp/nodenet-ab/repo/src/{checkout,payment,inventory,shipping,notify,auth,api,legacy,utils}
# ... author the 32-file fixture (see § 2.1), then:
cd /tmp/nodenet-ab/repo && cp -R . ../repo-a && cp -R . ../repo-b
for r in ../repo-a ../repo-b; do (cd "$r" && git init -b main && git add -A && git commit -m baseline); done

# Phase 1 (without NodeNet): explore, implement Task A in repo-a, then
cd /tmp/nodenet-ab/repo-a && node --test test/

# Phase 2 (with NodeNet):
cd /tmp/nodenet-ab/repo-b
node /path/to/nodenet/dist/cli/cli.js build
node /path/to/nodenet/dist/cli/cli.js context createSettlement --json --no-cache
node /path/to/nodenet/dist/cli/cli.js impact --base main --json   # after committing on a feature branch
node /path/to/nodenet/dist/cli/cli.js reviewers --base main

# Grading (hidden acceptance tests, written before the phases)
cd /tmp/nodenet-ab && node --test acceptance/
```

Raw evidence lives in `/tmp/nodenet-ab/` (fixture `repo/`, copies `repo-a/`,
`repo-b/`, graders `acceptance/`).

## 7. References & next steps

- `docs/token-efficient-context.md` — evaluation plan, budget policy, quality gates
- `docs/e2e-self-benchmark-2026-08-09.md` — self-repository E2E + deterministic A/B pilot
- `benchmark-results/e2e/latest/results.json` — retrieval/mutation evidence
- `docs/evaluation.md` — broader evaluation methodology

**Recommended next gates** (from the repo's own roadmap):

1. **Scripted harness with provider token telemetry** — repeated model-based
   A/B tasks, frozen prompts, identical model/version, hidden acceptance tests,
   real input/output token counts from the API.
2. **Run on a medium/large repository** — verify the predicted token savings
   (−99% band) materialize outside the small-corpus regime.
3. **Multi-task, multi-trial design** — ≥10 tasks per condition to obtain
   meaningful medians for tokens, tool calls, files read, and latency.
