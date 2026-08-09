# ADR 005: MCP server design

- Status: accepted
- Date: 2026-08-07

## Context

NodeNet must expose its graph, living context, ownership, authority, change
impact and reviewer resolution to AI coding assistants (spec §29, §61).
Candidates: the official `@modelcontextprotocol/sdk` (requires Zod), or a
minimal hand-rolled server over the MCP stdio transport.

## Decision

A **minimal, dependency-free MCP server** over stdio: newline-delimited
JSON-RPC 2.0. Surface implemented: `initialize`, `notifications/initialized`,
`tools/list`, `tools/call`, `ping`, `shutdown`. Tool arguments are
runtime-validated with **Valibot** (consistent with
[002-runtime-validation.md](002-runtime-validation.md)); nothing else is added.

Command: `nodenet mcp`. Tools: `query`, `related`, `trace`, `context` (MSC
bundle), `explain`, `governed_by`, `owner`, `impact`, `reviewers`, `health`,
`critical_review`, `graph`.

## Rationale

| Criterion | Hand-rolled (Valibot) | Official SDK |
| --- | --- | --- |
| New runtime deps | **0** | SDK + Zod |
| Schema consistency (ADR 002) | ✅ same lib | ❌ second lib |
| Deterministic, auditable output | ✅ | ✅ |
| Protocol coverage | core tools subset | full spec |
| Maintenance | manual protocol updates | upstream SDK |

NodeNet's product principles (spec §1: lightweight) and the ADR-002 decision
to keep a single schema library outweigh the convenience of the SDK for the
small tool surface required. All tools reuse the existing deterministic
analysis — nothing about the graph model or governance changes.

## Security

- Tools never execute repository code; they query the persisted graph and
  run git with arg arrays only.
- Every successful result and error passes through a centralized,
  fail-closed secret-disclosure control before leaving the server.
- Governance-sensitive retrieval rejects stale repository inputs, and target
  resolution returns all plausible candidates rather than selecting silently.
- Potentially large results use a common 2,000-token default response budget;
  truncation is explicit. The `context` builder retains mandatory governance
  evidence through its section-aware budget.
- Runtime validation enforces unknown-property rejection and advertised
  integer ranges.
- Tool errors are returned as MCP `isError` results — a failing tool never
  crashes the server.

The HTTP command remains an experimental JSON-RPC bridge, not MCP Streamable
HTTP. It defaults to loopback, requires authentication for remote binding, and
validates Origin, Content-Type, and Accept headers. Bearer credentials can be
restricted to `graph:read`, `context:read`, `impact:read`, `governance:read`,
and `health:read`; lifecycle state is isolated per credential. `query` and
`related` provide bounded cursor pagination with explicit selected, omitted,
and next-cursor metadata.

Shared-service hardening adds a per-credential token bucket, an immutable
snapshot store that atomically replaces config and analysis state, and
terminable worker execution for built-in tool calls in compiled distributions.
Every built-in tool advertises and runtime-validates a versioned output schema.
Security audit records are hash chained and can be checked with
`nodenet audit-verify`. Operational details and safe defaults are documented in
[MCP operations](../mcp-operations.md).

## Consequences

- Stdio is the conforming local transport. The HTTP surface is deliberately
  labeled an experimental JSON-RPC bridge until Streamable HTTP is implemented.
- New tools are added as entries in `src/mcp/server.ts` with a Valibot schema.
- Protocol version negotiation follows the MCP spec; updates are manual but
  small.
