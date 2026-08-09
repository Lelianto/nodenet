# Operating NodeNet MCP safely

This guide explains the current MCP security and reliability controls. The
stdio server is the recommended local integration. `nodenet serve` remains an
experimental HTTP JSON-RPC bridge, not full MCP Streamable HTTP.

## Local stdio

```bash
nodenet build
nodenet mcp
```

The client must complete `initialize`, send `notifications/initialized`, and
then call tools. Governance-sensitive calls fail closed when inputs are stale.

## Shared HTTP bridge

```bash
export NODENET_MCP_TOKEN="use-a-secret-from-your-secret-manager"

nodenet serve \
  --host 127.0.0.1 \
  --port 7341 \
  --token "$NODENET_MCP_TOKEN" \
  --scopes graph:read,context:read \
  --rate-capacity 60 \
  --rate-refill 10 \
  --reload-interval 2000
```

Do not put tokens in configuration, source control, logs, or shell history.
Prefer environment injection from a secret manager. Non-loopback binding is
rejected unless a bearer credential is configured.

### Scopes

| Scope | Tools/capability |
| --- | --- |
| `graph:read` | `query`, `related`, `trace`, `explain`, `graph`, `report` |
| `context:read` | `context`, `governed_by`, `owner` |
| `impact:read` | `impact` |
| `governance:read` | `reviewers`, `critical_review` |
| `health:read` | HTTP health and the `health` tool |

`tools/list` only advertises available tools. A call outside its scope returns
JSON-RPC `-32001`. Programmatic deployments can configure multiple
`McpHttpCredential` records bound to repositories. Lifecycle state and rate
limits are isolated per credential.

### Rate limiting

The default token bucket permits a burst of 60 requests and refills 10 tokens
per second per credential. Rejection returns HTTP `429`, `Retry-After`,
`X-RateLimit-Limit`, and `X-RateLimit-Remaining`.

### Atomic reload

The bridge checks for stale inputs every two seconds by default. It builds and
validates a complete replacement config and analysis state, then swaps one
immutable reference. Running requests retain their old snapshot; later
requests receive the new one. Use `--no-reload` if an external controller owns
rebuilds. Reload builds locally, so a large rebuild can still consume CPU.

### Execution timeout and cancellation

In compiled distributions, `tools/call` runs in a worker thread. At the HTTP
deadline NodeNet terminates the worker and returns HTTP `504` with
`tool_execution_cancelled`. Source-only development runtimes without the
compiled worker fall back to inline execution; run `npm run build` before
testing cancellation.

### Output contracts and pagination

Every built-in tool advertises a version-1 `outputSchema`; successful output is
validated before disclosure. JSON structured content includes the tool name
and `untrusted_repository_evidence` trust marker. Schema mismatch fails closed.

`query` and `related` accept `cursor` and `limit` and return:

```json
{
  "pagination": {
    "cursor": 0,
    "limit": 50,
    "selectedItems": 50,
    "totalItems": 83,
    "omittedItems": 33,
    "nextCursor": 50
  }
}
```

Continue with `cursor: 50`; never assume the first page is complete.

## Audit integrity

New `.nodenet/audit.jsonl` records contain `previousHash` and `recordHash`.
Legacy unsigned records may remain as a prefix, but an unsigned record after
the chain starts invalidates verification.

```bash
nodenet audit-verify
nodenet audit-verify --json
```

Hash chaining detects modification; it does not prevent deletion of the whole
log. Export records to restricted external append-only storage for stronger
assurance.

## Common errors

| Error | Meaning/action |
| --- | --- |
| `-32001` | Credential lacks the required scope or repository binding. |
| `-32002` | Complete MCP initialization first. |
| HTTP `429` | Wait for `Retry-After` or reduce request rate. |
| HTTP `504` | Tool exceeded its deadline and its worker was terminated. |
| `ambiguous_target` | Query first, then use the selected stable node ID. |
| `Stale analysis state` | Wait for reload or run `nodenet build`. |
| `Output contract violation` | Treat as an implementation defect. |

## Remaining boundary

These controls do not make the HTTP bridge a regulated governance authority.
Streamable HTTP conformance, TLS termination, external identity, centralized
tamper-resistant logging, availability engineering, penetration testing, and
formal residual-risk acceptance remain deployment responsibilities.
