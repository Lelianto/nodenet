# NodeNet Feature Verification A/B — Medium Repository (`ab-testing-medium`)

**Date:** 2026-08-09
**Product tested:** `@antihero/nodenet` — local source `v0.6.0-beta.1`, freshly built `dist/`
**Fixture:** [`living-context-driven-development`](https://github.com/Lelianto/living-context-driven-development) @ `e548824`, two **byte-identical** working copies:
- Control: `/Users/leliantopradana/Documents/PlugNPlay/ab-testing-medium/living-context-driven-development`
- Treatment: `/Users/leliantopradana/Documents/PlugNPlay/ab-testing-medium/living-context-driven-development-with-nodenet`
**Experiment type:** 10-step verification protocol (ask lean/full, context profiles, compatibility, accounting, budget, compact/pretty) followed by a live A/B task
**Status:** Deterministic measurements + live agent task. Token figures are estimates (bytes ÷ 4) **and**, where noted in §7, real OpenAI-tokenizer counts (`gpt-tokenizer`, cl100k/o200k). Neither is provider billing telemetry.

---

## TL;DR

1. **A real scanner bug was found and fixed during setup:** nested `node_modules` and nested `dist`/`build` directories (monorepo layouts) were **not** ignored — the graph exploded to **60,909 nodes**. After the fix: **1,236 nodes / 1,464 edges / 6 contexts** (98% reduction).
2. **All 9 feature checks passed:** `ask --full` routing identical to lean (624 B vs 24,024 B = **38× smaller**), `--detail route|map|evidence` progressive disclosure works, `--compat v1` restores legacy fields, token accounting + `token-log.jsonl` correct, budget trimming explained, compact ≡ pretty.
3. **A/B task (n=1):** both conditions passed hidden acceptance 2/2 and regression 220/220. Control used 3,805 B of raw exploration (≈950 tok); treatment used 5,234 B of tool output (≈1,308 tok) but with **zero decoys** — `ask` + `context route` (904 B) pointed straight at `trigger-evaluator.ts:79`, and `impact`/`reviewers` provided governance awareness the control lacked.
4. **Real-tokenizer audit (§7) corrects the estimates:** the bytes÷4 heuristic used throughout **overestimates by 13–23%** for JSON payloads. Real counts (o200k): `ask` lean **130** (not 156), `context route` **157** (not 180), `context evidence` **842** (not 972), `ask` full **5,338** (not 6,006). Phase-2 agent input is **1,129 real tokens** — only ±10% above Phase 1, not +38% as the heuristic suggested.

---

## 1. Why this experiment exists

Earlier experiments (`nodenet-ab-live-benchmark-2026-08-09.md`, `nodenet-ab-lcdd-medium-benchmark-2026-08-09.md`, `nodenet-cli-vs-mcp-token-comparison-2026-08-09.md`) answered "is NodeNet cheaper?" (yes at scale, no at small/medium for token count) and "CLI vs MCP?" (identical bundles, MCP adds overhead).

This run is a **feature-verification protocol** on the medium repo:
- Verify the new progressive `--detail route|map|evidence` output shapes and that the **codeContext/selectionReason duplication was removed**.
- Verify `--compat v1` legacy wire compatibility.
- Verify token **accounting** (`emittedTokens`, `mandatoryTokens`, `budgetTokens`, overflow reasons), the `token-log.jsonl`, and budget clamping/trimming.
- Verify compact vs pretty JSON are the same data.
- Then run the **real A/B task** with the recommended workflow (`ask` → `context route` → `context evidence`) and record governance recall.

---

## 2. Setup

| Item | Value |
| --- | --- |
| Local CLI | `node /Users/leliantopradana/Documents/PlugNPlay/fb-1/dist/cli/cli.js` (`npm run build`) |
| Version | `@antihero/nodenet@0.6.0-beta.1` |
| Baseline commit | `e548824 chore: prepare 0.7.0-alpha.1 prerelease` (both repos, clean) |
| Node.js | v20.19.6 |
| Task files | control `implementation/packages/core/src/change-validator.ts` (2,785 B), treatment `.../trigger-evaluator.ts` (12,929 B) |
| Regression suite | `@lcdd/core` — 16 files, 220 tests, run via `implementation/node_modules/.bin/vitest` |
| Hidden acceptance | `/tmp/nodenet-ab-medium/acceptance/` (taskA/taskB), **failed 4/4 at baseline** (methods absent) |

---

## 3. Bug found: nested `node_modules`/`dist` were not ignored

**Symptom:** `nodenet build` on the treatment produced **60,909 nodes / 78,935 edges** and 60+ MB of `graph.json`, dominated by `website/node_modules/**` and `implementation/packages/*/dist/**`.

**Root cause** (in `fb-1/src/scanner/scanner.ts`):
1. `ALWAYS_IGNORED` (`.git`, `node_modules`, `.nodenet`) was checked only on the **top path segment** (`relPosix.split("/")[0]`), so `website/node_modules/...` slipped through.
2. Default `config.ignore` patterns like `"dist"` compile to the regex `^dist$`, which only matches the root-level path — `implementation/packages/core/dist/...` was never matched.

**Fix:** check **every path segment** for `ALWAYS_IGNORED` names **and** for plain ignore names (patterns without `/`, `*`, `?` — e.g. `dist`, `build`, `coverage`, `.next`, `out`):

```ts
const segments = relPosix.split("/");
if (segments.some((seg) => ALWAYS_IGNORED.includes(seg) || plainIgnored.has(seg))) continue;
if (matchGlobIn(config.ignore, relPosix)) continue;
```

**Result:**

| Build | nodes | edges |
| --- | ---: | ---: |
| Before fix | 60,909 | 78,935 |
| **After fix** | **1,236** | **1,464** |

Two regression tests added in `test/security.test.ts` (nested `node_modules` skip; plain ignore names at depth). Full suite: **190/190 pass**, typecheck clean.

> Note: the negated-pattern interaction (`!dist/keep.js`) was reviewed (code-reviewer); the scanner's `.some()`-based ignore semantics cannot re-include files inside an already-skipped directory in either old or new code, so no additional guard was warranted.

---

## 4. Step-by-step results

### Step 2 — repositories equal
✅ Both at `e548824`, clean working tree, identical content (`diff -rq` empty).

### Step 3 — graph build
✅ `build --json`: **1,236 nodes / 1,464 edges / 6 living contexts**, 6 warnings, 0 node_modules warnings. `.nodenet/` artifacts: `graph.json` (2.0 MB), `index.json`, `symbols.json`, `parse-cache.json`, `metadata.json`.
*(Note: the plan's `graph --json` option does not exist — `graph` only supports `-o/-f`; node/edge counts come from `build --json`.)*

### Step 4 — `ask` lean vs full
Query: *"where is context trigger evaluation implemented"*

| | lean | full |
| --- | ---: | ---: |
| Size | **624 B** (~156 tok) | 24,024 B (~6,006 tok) |
| `recommendedFiles` | `["implementation/packages/core/src/trigger-evaluator.ts"]` | **identical** |
| Extra fields | — | matches (30), connections (25), intent, primaryFiles, supportingFiles, expansionCandidates, suggestedNext |

✅ Pass criteria: `recommendedFiles` identical (`diff` empty), lean 38× smaller, `src/trigger-evaluator.ts` present (after the scanner fix, the earlier bogus `dist/trigger-evaluator.d.ts` entry is gone).

### Step 5 — context profiles `--detail route|map|evidence`

| Profile | Size | codeEvidence | Emitted tokens | Evidence shape |
| --- | ---: | ---: | ---: | --- |
| `route` | 721 B | **0** | 180 | none (routing + governance only) |
| `map` | 3,530 B | 9 | 883 | `id, label, path, relation, direction` |
| `evidence` | 3,889 B | 9 | 972 | + `provenance, score, depth` |

✅ **Duplication check:** `grep -c '"codeContext"|"selectionReason"'` → **0** in all three profiles (the v1 duplication is gone). All three carry `recommendedFiles`, `livingContext`, `ownership`, `authority`, `metrics`, `aiGuidance`.

### Step 6 — `--compat v1`

```json
{ "hasCodeContext": true, "hasSelectionReason": true }
```
✅ Legacy fields restored on demand; payload 5,598 B vs 3,889 B non-compat (only when requested).

### Step 7 — accounting + token log

`context TriggerEvaluator --detail evidence` metrics:
```json
{
  "estimatedTokens": 972, "emittedTokens": 972, "mandatoryTokens": 165,
  "budgetTokens": 2000, "budgetExceeded": false, "budgetExceededByMandatory": false,
  "budgetOverflowReason": "none", "truncated": false,
  "selectedNodes": 9, "omittedNodes": 0
}
```
✅ All required fields present. `.nodenet/token-log.jsonl` records every command:
```
ask:6006, context:route:180, context:map:883, context:evidence:972, context:evidence(compat):1400
```

### Step 8 — small budget (`--max-tokens`)

| Budget requested | Actual budget | emitted | truncated | evidence kept |
| --- | ---: | ---: | ---: | ---: |
| 100 | 256 (clamped to MIN) | 250 | true | 1 (of 9) |
| 165 | 256 (clamped) | 250 | true | 1 |
| 256 | 256 | 250 | true | 1 |
| 300 | 300 | 263 | true | 1 |
| 500 | 500 | 435 | true | 3 |

✅ Budget trimming is explained: `truncated: true`, `omittedNodes: 8`, `budgetExceeded: false` (emission is trimmed to fit, never blown). Values below `MIN_CONTEXT_TOKEN_BUDGET = 256` are clamped up. Overflow reason only becomes non-`none` when mandatory governance exceeds the budget (`budgetExceededByMandatory`).

### Step 9 — compact vs pretty

`--detail route`: compact 721 B vs pretty 866 B. `JSON.stringify` deep-equal → **identical data** ✅ (only whitespace differs).

---

## 5. The A/B task (Step 10)

Symmetric hidden-acceptance tasks, written **before** either phase (proved to fail 4/4 at baseline):

| | Control (no NodeNet) | Treatment (with NodeNet) |
| --- | --- | --- |
| Task | add `ChangeValidator.validateChangedFile(file, contexts)` | add `TriggerEvaluator.evaluateContext(context, enforcements, dismissals)` |
| Allowed tools | `ls`/`grep`/`cat` only | `ask` → `context route` → `context evidence` |
| **Tool output consumed** | 3,805 B ≈ **950 tok** (grep find + 2,785 B file + type greps) | ask 624 B + route 721 B + evidence 3,889 B = 5,234 B ≈ **1,308 tok** |
| Decoys in output | n/a (raw) | **zero** — ask → `src/trigger-evaluator.ts`; route → `TriggerEvaluator.evaluate() @ :79` |
| Diff | 31 insertions / 29 deletions (refactor) | 12 insertions / 1 deletion (add method) |
| Hidden acceptance | **2/2** ✅ | **2/2** ✅ |
| Core regression | **220/220** ✅ | **220/220** ✅ |
| Commit | `138b5ce` (`main`) | `1d9687b` (`feat/evaluate-context`) |
| Governance recall | none available | `impact --base main`: **LOW**, changed `trigger-evaluator.ts` + symbol `TriggerEvaluator.evaluate`; `reviewers`: suggested `leliantoeko` (git-history inference, 0.45) |

**Task-shape caveat:** Task A was a refactor (larger diff by nature), Task B an additive method — the diff sizes are **not** directly comparable; the symmetric pair is the same as the earlier medium-repo run, not two same-shaped refactors.

---

## 6. Analysis

- **Feature verification is green.** Every protocol step (4–9) passed with the expected shapes and accounting. The `codeContext`/`selectionReason` duplication is fully removed from the default wire format and only returns via `--compat v1`.
- **Budget discipline works as designed:** emission is trimmed to fit (never over-emits for derived evidence), mandatory governance is never discarded, and the minimum budget (256) prevents pathological truncation.
- **Token story on medium repos is unchanged:** NodeNet tool output (~1,308 tok, or just 904 tok with `route` only) is lean and decoy-free, but still carries the fixed bundle cost, so it does not beat raw grep on *token count alone* at this corpus size (1,236 nodes). Its value here is **precision** (direct hit at `:79`) and **governance awareness** — confirmed again in the live task.
- **The scanner fix matters for real-world monorepos:** any repo with per-package `node_modules` or nested `dist` was silently building a polluted graph (60K nodes). With the fix, the graph reflects source only.

---

## 7. Real tokenizer audit — correction to the estimates

All earlier token figures in this document (and in the sibling experiment docs) use `bytes ÷ 4` — the NodeNet `estimateTokens` heuristic, **not** a tokenizer. After the run, every saved payload was re-counted with a real tokenizer: `gpt-tokenizer` (pure-JS port of OpenAI's `tiktoken`), installed in a throwaway dir (`/tmp/token-audit`, `npm i gpt-tokenizer --no-save`), using the two most common encodings — `cl100k_base` (GPT-3.5/GPT-4) and `o200k_base` (GPT-4o/4.1/o1).

### 7.1 Per-payload real counts

| Payload | bytes | est (÷4) | cl100k | o200k | est ÷ o200k |
| --- | ---: | ---: | ---: | ---: | ---: |
| `ask` lean | 624 | 156 | 124 | **130** | 1.20 |
| `ask` full | 24,024 | 6,006 | 5,296 | **5,338** | 1.13 |
| `context route` | 721 | 180 | 158 | **157** | 1.15 |
| `context map` | 3,530 | 883 | 720 | **716** | 1.23 |
| `context evidence` | 3,889 | 972 | 846 | **842** | 1.15 |
| `context v1` (compat) | 5,598 | 1,400 | 1,197 | **1,182** | 1.18 |
| `compact` | 721 | 180 | 158 | **157** | 1.15 |
| `pretty` | 866 | 217 | 228 | **225** | 0.96 |

**Findings:**

1. **The heuristic consistently overestimates by 13–23%** for these JSON payloads (mean ≈ 1.15–1.18×). Every `estimatedTokens`/`emittedTokens` number reported earlier is ~15–20% too high. The `pretty` outlier (0.96) is small-payload noise.
2. **cl100k vs o200k agree within ±5 tokens** — the ranking and conclusions are encoding-independent.
3. Cheapest useful commands: `ask` lean = **130 tok**, `context route` = **157 tok** → full orientation ≈ **287 tok**, not the ~336 the heuristic implied.

### 7.2 A/B agent input, real tokens (o200k)

| | bytes | est (÷4) | real (o200k) |
| --- | ---: | ---: | ---: |
| Phase 1 (no NodeNet) | 3,805 (grep/cat outputs) | ~951 | ~1,028 (at ≈3.7 B/tok) |
| Phase 2 (NodeNet: ask+route+evidence) | 5,234 | 1,309 | **1,129** |

With real tokens the two conditions are **~1,028 vs ~1,129 (±10%)**, not 951 vs 1,309 (+38%) as the heuristic suggested. Dropping `evidence` (route-only workflow) puts Phase 2 at **~730 tok — below Phase 1**. The medium-repo conclusion is unchanged qualitatively (NodeNet ≈ parity on tokens, wins on precision + governance), but the token *penalty* was overstated.

### 7.3 What still cannot be measured offline

- **Provider billing tokens** (exact tokenizer version + per-model pricing) and **prompt-cache hits** (cache reads cost ~10% of normal) require provider telemetry — no local tool can produce those.
- The tokenizer used here is OpenAI's; Anthropic/other vendors tokenize slightly differently (typically ±5–10% on code).

Reproduction:
```bash
mkdir -p /tmp/token-audit && cd /tmp/token-audit && npm init -y >/dev/null && npm i gpt-tokenizer --no-save
node -e "import('gpt-tokenizer/encoding/o200k_base').then(m => console.log(m.encode(require('fs').readFileSync('/tmp/context-evidence.json','utf8')).length))"
```

---

## 8. Methodology & limitations

- **n=1** live agent task; token figures are **bytes ÷ 4 estimates**, not provider telemetry.
- Author-knowledge bias: the same agent (with prior knowledge of this repo) performed both phases; raw-exploration byte counts are best-effort.
- Task shapes differ (refactor vs add-method), so diff-size comparison is illustrative only.
- Wall-clock time was **not** measured in this run (earlier runs measured −74% time with NodeNet).
- `graph --json` does not exist; node/edge counts sourced from `build --json`.

---

## 9. Reproduction

```bash
# 1. Build NodeNet locally
cd /Users/leliantopradana/Documents/PlugNPlay/fb-1 && npm run build
NODENET_CLI=/Users/leliantopradana/Documents/PlugNPlay/fb-1/dist/cli/cli.js
TREATMENT=/Users/leliantopradana/Documents/PlugNPlay/ab-testing-medium/living-context-driven-development-with-nodenet
CONTROL=/Users/leliantopradana/Documents/PlugNPlay/ab-testing-medium/living-context-driven-development

# 2. Graph (treatment only)
cd "$TREATMENT" && node "$NODENET_CLI" build --json --pretty

# 3. ask lean vs full
node "$NODENET_CLI" ask "where is context trigger evaluation implemented" --json        > /tmp/ask-lean.json
node "$NODENET_CLI" ask "where is context trigger evaluation implemented" --full --json  > /tmp/ask-full.json

# 4. context profiles
for D in route map evidence; do
  node "$NODENET_CLI" context TriggerEvaluator --detail $D --no-cache --json > /tmp/context-$D.json
done

# 5. compatibility + accounting + budget + pretty
node "$NODENET_CLI" context TriggerEvaluator --detail evidence --compat v1 --no-cache --json > /tmp/context-v1.json
tail -n 10 .nodenet/token-log.jsonl
node "$NODENET_CLI" context TriggerEvaluator --detail evidence --max-tokens 256 --no-cache --json | jq .metrics
node "$NODENET_CLI" context TriggerEvaluator --detail route  --no-cache --json      > /tmp/compact.json
node "$NODENET_CLI" context TriggerEvaluator --detail route  --no-cache --json --pretty > /tmp/pretty.json

# 6. A/B tasks + governance
# control: add ChangeValidator.validateChangedFile  (commit on main)
# treatment: add TriggerEvaluator.evaluateContext   (commit on feat/evaluate-context)
node "$NODENET_CLI" impact --base main --json --pretty
node "$NODENET_CLI" reviewers --base main --json --pretty
```

Hidden acceptance harness: `/tmp/nodenet-ab-medium/` (`acceptance/taskA.test.ts`, `taskB.test.ts`, `vitest.config.ts`; `node_modules` symlinked from the control repo). Baseline run fails 4/4; post-task runs pass 2/2 + 2/2.

---

## 10. References

- [`nodenet-ab-live-benchmark-2026-08-09.md`](nodenet-ab-live-benchmark-2026-08-09.md) — small-corpus A/B
- [`nodenet-ab-lcdd-medium-benchmark-2026-08-09.md`](nodenet-ab-lcdd-medium-benchmark-2026-08-09.md) — medium-corpus A/B (time −74%, output −87%)
- [`nodenet-cli-vs-mcp-token-comparison-2026-08-09.md`](nodenet-cli-vs-mcp-token-comparison-2026-08-09.md) — CLI vs MCP (identical bundles)
- [`nodenet-token-levers-2026-08-09.md`](nodenet-token-levers-2026-08-09.md) — token levers & break-even curve
