# NodeNet CLI vs MCP — Token Cost Comparison

**Date:** 2026-08-09
**Product tested:** `@antihero/nodenet` — local source `v0.6.0-beta.1`, freshly built `dist/`
**Repository under test:** [`living-context-driven-development`](https://github.com/Lelianto/living-context-driven-development) @ `e548824` (649 graph nodes, 890 edges, 6 living contexts) — copy at `/tmp/nodenet-ab-lcdd/repo-b`
**Question answered:** *"Kenapa token tetap lebih banyak saat menggunakan NodeNet? Apakah karena tidak memakai MCP?"*

**Answer in one line:** Tidak. Tool MCP `context` memanggil builder bundle yang **sama persis** dengan CLI (`buildContextBundle`), menghasilkan `estimatedTokens` yang identik — dan MCP bahkan menambah overhead skema tool, bukan menguranginya.

## 1. Why this experiment exists

The medium-repository A/B benchmark (`nodenet-ab-lcdd-medium-benchmark-2026-08-09.md`)
showed higher *input* tokens with NodeNet (~1,620 vs ~1,100 est.) on a 649-node
repo. A natural hypothesis was that this happened because the agent used the
CLI instead of the NodeNet MCP server. This experiment tests that hypothesis
directly: same repo, same target, same bundle builder, CLI vs MCP stdio.

## 2. Method

### 2.1 Code evidence (static)

`src/mcp/server.ts`, tool `context` (line ~362):

```ts
const bundle = buildContextBundle(graph, index, ownership, contexts, candidates[0]!.id, {
  ...(maxTokens !== undefined ? { maxTokens } : {}),
  detail, ...(detail === "source" ? { root: ctx.root } : {}),
});
```

This is the exact same `buildContextBundle` used by the CLI `context` command.
The transport (stdio JSON-RPC vs argv) cannot change the bundle content.

### 2.2 Runtime measurement

MCP server started via `node dist/cli/cli.js mcp` (newline-delimited JSON-RPC 2.0
over stdio) inside `/tmp/nodenet-ab-lcdd/repo-b`, then:

1. `initialize` → `notifications/initialized` → `tools/call` `{ name: "context", arguments: { target } }`
2. CLI: `node dist/cli/cli.js context <target> --json --no-cache`

Raw request/response files: `/tmp/mcp-request.jsonl`, `/tmp/mcp-response.jsonl`,
`/tmp/cli-context.json`.

## 3. Results

### 3.1 Fair comparison — identical target `TriggerEvaluator.evaluate`

| Measurement | CLI `context --json` | MCP tool `context` |
| --- | ---: | ---: |
| Resolved target | `TriggerEvaluator.evaluate() @ trigger-evaluator.ts:79` | `TriggerEvaluator.evaluate() @ trigger-evaluator.ts:79` |
| `codeEvidence` items | 9 | 9 |
| `metrics.estimatedTokens` | **1,367** | **1,367** |
| Raw bytes sent to the model | 5,469 (bare JSON) | 6,377 (text + JSON-RPC wrapper) |

**The bundle is byte-for-byte equivalent in content** (same target, same 9
evidence nodes, same 1,367 estimated tokens). The only difference is the
transport envelope: MCP wraps the bundle in `content[0].text` + `_meta` +
`structuredContent` (3,127 B of duplicate structured data), making it *larger*
on the wire — not smaller.

### 3.2 What looked like a difference (and was not)

First run used target `TriggerEvaluator` (bare class name):

| Measurement | CLI | MCP |
| --- | ---: | ---: |
| Resolved target | `TriggerEvaluator.evaluate()` (method — CLI rank-expands exact class hits) | `TriggerEvaluator` (class) |
| `codeEvidence` | 9 | 5 |
| Raw bytes | 6,378 | 3,601 |

The CLI `queryMatches` helper expands an exact class hit with its methods from
the same source file, so `TriggerEvaluator` resolved to the *method* and pulled
more evidence. That is a **target-resolution difference, not a transport
difference** — with the same target string both transports return identical
bundles (§ 3.1).

### 3.3 MCP adds overhead, it does not save tokens

| Overhead component | Where | Cost |
| --- | --- | --- |
| Tool schemas + descriptions injected per session | `tools/list` (15 tools, 21 `description:` lines in `server.ts`) | Fixed per-session tokens on every prompt |
| JSON-RPC response envelope | `content[0].text` + `_meta` + `structuredContent` | +~900 B raw on top of the bundle |
| `structuredContent` duplicates the text payload | `toolResult()` | +3,127 B raw |

None of these exist in the CLI path.

## 4. Conclusion

1. **The higher token count with NodeNet is the fixed MSC bundle cost (~1.4K
   tokens per query), not the CLI-vs-MCP choice.** On a small/medium repo the
   bundle exceeds the raw-read savings (grep + a few targeted reads); token
   savings are a **large-corpus** phenomenon (the deterministic A/B on the
   1,099-node self-repo shows −99.45% for broad-read vs `ask` + context).
2. **MCP calls the same builder** (`buildContextBundle`) and returns the same
   bundle (`estimatedTokens` 1,367 in both). Switching to MCP would *not* reduce
   tokens.
3. **MCP actually adds tokens**: tool-schema overhead per session + JSON-RPC
   envelope + duplicate `structuredContent`.
4. The only observable size differences come from **target resolution**
   (class vs method), not transport.

## 5. What actually reduces tokens

| Lever | Effect (measured) |
| --- | --- |
| `context <t> --detail map` | Same bundle at `evidence` detail for this target (1,367) |
| `context <t> --detail map --max-tokens 500` | **407** estimated tokens (bounded budget) |
| `ask` / `query` tools | Scoped subgraph instead of full bundle |
| Context caching | Repeated queries cheaper per graph version (`src/ai/context-cache.ts`) |
| Larger repository (>2K nodes) | Fixed bundle cost amortizes against growing broad-read cost |

## 6. Reproduction

```bash
cd /tmp/nodenet-ab-lcdd/repo-b   # NodeNet graph already built

# CLI
node /path/to/nodenet/dist/cli/cli.js context TriggerEvaluator.evaluate --json --no-cache

# MCP over stdio (JSON-RPC 2.0, newline-delimited)
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"bench","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"context","arguments":{"target":"TriggerEvaluator.evaluate"}}}' \
  | node /path/to/nodenet/dist/cli/cli.js mcp
```

Compare `metrics.estimatedTokens` in both outputs — they are identical.

## 7. References

- `nodenet-ab-lcdd-medium-benchmark-2026-08-09.md` — medium-repo A/B benchmark (source of the question)
- `nodenet-ab-live-benchmark-2026-08-09.md` — small-corpus A/B benchmark
- `docs/token-efficient-context.md` — evaluation plan, budget policy, quality gates
- `src/mcp/server.ts` — MCP tool definitions (tool `context`, `toolResult`, `secureToolOutput`)
- `src/ai/context-builder.ts` — `buildContextBundle`, `DEFAULT_CONTEXT_TOKEN_BUDGET`
