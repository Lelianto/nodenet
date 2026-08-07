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
`graph`.

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
- `context` runs the MSC builder, whose output is secret-scanned (spec §46).
- Tool errors are returned as MCP `isError` results — a failing tool never
  crashes the server.

## Consequences

- Only the stdio transport is provided today; HTTP is a future addition.
- New tools are added as entries in `src/mcp/server.ts` with a Valibot schema.
- Protocol version negotiation follows the MCP spec; updates are manual but
  small.
