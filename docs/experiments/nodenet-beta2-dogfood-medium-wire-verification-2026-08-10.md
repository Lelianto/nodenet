# NodeNet 0.6.0-beta.2 Dogfood — Wire Compatibility on the Medium Fixture

**Date:** 2026-08-10
**Product under test:** `@antihero/nodenet@0.6.0-beta.2`, installed **from the packed artifact**
[`antihero-nodenet-0.6.0-beta.2.tgz`](../../antihero-nodenet-0.6.0-beta.2.tgz) into a clean throwaway
project (`/tmp/nodenet-dogfood-beta2`) via `npm install <tarball>`.
**Fixture:** [`living-context-driven-development`](https://github.com/Lelianto/living-context-driven-development)
treatment copy at `ab-testing-medium/living-context-driven-development-with-nodenet`,
whose `.nodenet/` artifacts were LAST built by the previous **beta.1** release (2026-08-09 22:24).
**Purpose (Step 1–2 of the beta-to-stable gate):** dogfood the shipped wire contract from the tarball on a
real repository, without a rebuild, and record whether the contract is ready to lock as `0.6.0`.

## 1. Artifacts checked (consistency)

| Artifact | Value |
| --- | --- |
| `package.json` version | `0.6.0-beta.2` |
| `dist/version.js` `NODENET_VERSION` | `0.6.0-beta.2` |
| MCP `initialize`.serverInfo.version | `0.6.0-beta.2` |
| Tarball | `antihero-nodenet-0.6.0-beta.2.tgz` (published on npm: `dist-tags.beta`) |
| `npm install <tarball>` | exit 0, **0 vulnerabilities** |

## 2. Migration path — beta.1 artifacts load on beta.2 without rebuild

`ask` and `context` ran against the **pre-existing beta.1-era graph** (`graph.json`, `symbols.json`,
`index.json`, parse cache, ownership/contexts). No `build` was run first. All commands resolved the
intended symbol and returned the same deterministic numbers as the beta.1 feature-verification run,
so the on-disk artifact format is backwards-compatible.

## 3. CLI wire checks (tarball binary, `--json`)

| Check | Result |
| --- | --- |
| `ask --json` (default) | **lean**: keys `queryId, intent, primaryFiles, supportingFiles, recommendedFiles, suggestedNext`; **624 B**; `codeContext` and `selectionReason` **absent**; `recommendedFiles` → `implementation/packages/core/src/trigger-evaluator.ts` |
| `ask --json --full` | verbose restored: `matches`, `connections`, `expansionCandidates` present |
| `context TriggerEvaluator --detail route` | **721 B**; `codeEvidence` count **0**; no `codeContext`/`selectionReason` |
| `context TriggerEvaluator --detail evidence` | **3,889 B**; `codeEvidence` count **9**; `metrics`: `{estimatedTokens:972, emittedTokens:972, mandatoryTokens:165, budgetTokens:2000, budgetExceeded:false, budgetExceededByMandatory:false, budgetOverflowReason:"none", truncated:false, selectedNodes:9, omittedNodes:0}` |
| `context TriggerEvaluator --detail evidence --compat v1` | **5,598 B**; restores `codeContext` (9 labels) and per-node `selectionReason` (e.g. `"outgoing references relation at depth 1; provenance=ast; deterministic score=13"`) |

All numbers match the beta.1 survey [nodenet-ab-medium-feature-verification-2026-08-09.md](nodenet-ab-medium-feature-verification-2026-08-09.md)
exactly — no wire drift between beta.1 and beta.2. The compat projection is implemented in
[`src/cli/cli.ts` `legacyContextPayload`](../../src/cli/cli.ts#L308): adds `codeContext` and injects
`selectionReason` into each `codeEvidence` entry, nothing else.

## 4. MCP transport — structured-only wire (new beta.2 contract)

JSON-RPC 2.0 over stdio (`nodenet mcp --tools core` default), handshake `initialize` →
`notifications/initialized` → `tools/list` → `tools/call`.

| Check | Result |
| --- | --- |
| `initialize` serverInfo | `{ name: "nodenet", version: "0.6.0-beta.2" }`, capabilities `{ tools: {} }` |
| Default preset | **`core`**: exactly 6 tools — `ask, affected, query, related, trace, context` (no governance tools) |
| `tools/call ask` | `content` array is **`[]`** (structured-only), data carried once in `structuredContent` with envelope `{ schemaVersion: "1", tool: "ask", trust: "untrusted_repository_evidence", data: {...} }`; lean keys, no `codeContext`/`selectionReason`; `recommendedFiles` correct |
| `tools/call context {detail: "route"}` | `content` `[]`, structured-only, `codeEvidence` **0** |
| Token accounting (`token-log.jsonl`) | `mcp:ask` → 156, `mcp:context` → 178 appended alongside CLI entries |

This confirms the beta.2 transport behavior: on a real MCP session the payload is emitted **once** through
`structuredContent` and the legacy text duplicate is dropped (see
[`src/mcp/server.ts` `toolResult`](../../src/mcp/server.ts#L708): `content: []` when `protocolState` is set).

## 5. Quality gates reconfirmed

- **191/191 tests pass** (23 files), typecheck clean, `dist` re-built from source for the published shape.
- No production vulnerabilities reported at install.

## 6. Verdict — Step 2 summary

No regression found during dogfooding. The beta.2 wire contract is stable on the tarball artifact for:

- lean `ask --json` default and `--full` opt-in,
- progressive `context --detail route|map|evidence` profiles,
- `--compat v1` migration bridge (byte-identical payload size to beta.1),
- MCP structured-only transport with `core` default preset,
- backwards-compatible loading of beta.1 graph artifacts.

Remaining before locking the contract as stable `0.6.0` (not blocking product stability): at least one
real-model MCP consumer run and A/B task evidence `n≥10` if the token-saving claim is to be published.
The same artifact, with no feature changes, can then be re-published as `0.6.0` and the `beta` tag removed.

## 7. Reproduction

```bash
# 1. Install the packed artifact into a clean project
cd /tmp/nodenet-dogfood-beta2 && npm init -y && npm install /Users/leliantopradana/Documents/PlugNPlay/fb-1/antihero-nodenet-0.6.0-beta.2.tgz

# 2. Wire checks against the existing (beta.1-built) graph — no rebuild
cd /Users/leliantopradana/Documents/PlugNPlay/ab-testing-medium/living-context-driven-development-with-nodenet
node /tmp/nodenet-dogfood-beta2/node_modules/.bin/nodenet ask "where is context trigger evaluation implemented" --json
node /tmp/nodenet-dogfood-beta2/node_modules/.bin/nodenet context TriggerEvaluator --detail route   --no-cache --json
node /tmp/nodenet-dogfood-beta2/node_modules/.bin/nodenet context TriggerEvaluator --detail evidence --compat v1 --no-cache --json

# 3. MCP structured-only transport (stdio JSON-RPC)
node /Users/leliantopradana/Documents/PlugNPlay/fb-1/scripts/mcp-dogfood-probe.mjs  # initialize / tools/list / tools/call
```