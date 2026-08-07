# NodeNet

```
#   #    ####   ####    #####   #   #   #####   #####
##  #   #   #   #   #   #       ##  #   #         #
# # #   #   #   #   #   ###     # # #   ###       #
#  ##   #   #   #   #   #       #  ##   #         #
#   #    ####   ####    #####   #   #   #####     #
```

**Know what changes. Know what it affects. Know who should review it.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](package.json)
[![Node.js](https://img.shields.io/badge/Node-%3E%3D18-339933.svg?logo=node.js)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg?logo=typescript)](tsconfig.json)
[![Status](https://img.shields.io/badge/status-reference%20implementation-8A2BE2.svg)](#roadmap)

AI coding agents can understand code.

But software is more than code.

Architecture decisions, business rules, ownership boundaries, security policies,
and team responsibilities determine whether a change should be made — and who
should review it.

NodeNet maps these relationships into an explainable graph.

```
CODE          →  CONTEXT      →  OWNERSHIP  →  AUTHORITY   →  CHANGE IMPACT  →  REVIEW
files, calls,     living rules,   who owns      who approves   what breaks,     who must
symbols, deps     governance      the code      hardened       what is affected  review it
```

NodeNet is a lightweight, local-first, secure, deterministic, strongly type-safe
developer tool. It is a practical reference implementation of **Living Context
Driven Development (LCDDD)** — the methodology that treats context as a living,
versioned, governed artifact (see
[living-context-driven-development](https://github.com/Lelianto/living-context-driven-development)).

---

## Contents

- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Key concepts](#key-concepts)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [How governance is declared](#how-governance-is-declared)
- [Configuration](#configuration)
- [Security](#security)
- [Documentation](#documentation)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [License](#license)

---

## The problem

A normal dependency graph can tell you:

> `CheckoutForm → PaymentService`

NodeNet understands:

> `CheckoutForm` **calls** `PaymentService`, which is **owned by** `Payment Team`,
> which is **governed by** `PAYMENT-003`, which requires **approval from**
> `Finance Team`.

So when the Checkout Team changes `CheckoutService`:

- **Impact:** HIGH — the change crosses an ownership boundary.
- **Required review:** `@payment-team`
- **Authority review:** `@finance-team`
- **Why:** `CheckoutService` modifies behavior dependent on `PaymentService`, which is governed by `PAYMENT-003`.

This is the core value: **not just what is connected, but what governs it, who
owns it, and who must review a change.**

## How it works

`nodenet build` runs a deterministic, offline pipeline (see
[ARCHITECTURE.md](ARCHITECTURE.md)):

```
repository
   │  nodenet build
   ▼
scan  ──►  parse (TypeScript Compiler API, per-file, deterministic)
   │            │
   │            ▼
   │     build code graph  (all nodes, then all edges — cross-file references
   │            │            always resolve, nothing is dropped)
   ▼            ▼
merge governance layers  (context, ownership, authority as typed nodes + edges)
   │
   ▼
persist  (.nodenet/graph.json + index.json fingerprints + symbols.json)
```

Analysis commands (`query`, `related`, `trace`, `impact`, `reviewers`, `health`,
...) load the persisted graph, re-validate it at runtime, and answer from one
unified, explainable model. Nothing ever leaves the machine.

## Key concepts

| Concept | What it answers | Docs |
| --- | --- | --- |
| Graph | What is connected, and why (every edge has provenance) | [docs/concepts/graph.md](docs/concepts/graph.md) |
| Living context | What rules govern the code, and how hard they are to change | [docs/concepts/living-context.md](docs/concepts/living-context.md) |
| Ownership | Who owns the code (≠ who has authority over rules) | [docs/concepts/ownership.md](docs/concepts/ownership.md) |
| Authority | Who says a rule is real, and what level of approval it needs | [docs/concepts/authority.md](docs/concepts/authority.md) |
| Change impact | What a diff breaks and which boundaries it crosses | [docs/concepts/change-impact.md](docs/concepts/change-impact.md) |
| Review governance | Who must review, who must approve, and why | [docs/concepts/review-governance.md](docs/concepts/review-governance.md) |

## Requirements

- **Node.js ≥ 18** (`engines` in `package.json`)
- **git** available in `PATH` (for `impact` / `reviewers` / `update`)

## Installation

```bash
# From npm
npm install -g @antihero/nodenet

# Or from source
git clone <your-fork> && cd nodenet
npm install
npm run build
```

Then run it inside any repository you want to map.

## Example project

See [examples/payments-demo](examples/payments-demo) — a ready-made checkout →
payment project with living context, ownership, authority and a cross-team PR
scenario. It ships a pre-built interactive [graph.html](examples/payments-demo/.nodenet/graph.html)
you can open in a browser, plus [README.md](examples/payments-demo/README.md) and
`./demo.sh` to rebuild everything:

```bash
npm run build
cd examples/payments-demo
./demo.sh          # build, visualize, query, impact + reviewers
```

## Quick start

```bash
nodenet init             # creates nodenet.config.json + .nodenet/
nodenet build            # scan, parse, analyze, persist the unified graph
nodenet query PaymentService
nodenet trace LoginForm AuthService
nodenet governed-by PaymentService
nodenet owner src/payment/PaymentService.ts
nodenet context "modify payment settlement"   # AI context bundle
nodenet impact --base main                    # analyze the current change
nodenet reviewers --base main                 # who should review it
nodenet health                                # context health report
nodenet graph                                 # static HTML visualization
```

An example session:

```text
$ nodenet owner src/payment/PaymentService.ts
src/payment/PaymentService.ts → payment-team (source: nodenet, confidence: authoritative)

$ nodenet governed-by src/payment/PaymentService.ts
Contexts governing src/payment/PaymentService.ts:
  PAYMENT-003 [ACTIVE] STANDARD — Settlement Processing Rule (approvers: finance-team)
  SEC-009 [ACTIVE] HARDENED — PCI Data Handling (approvers: security-team)

$ nodenet impact --base main
Impact: HIGH
Ownership boundary crossed: checkout-team → payment-team (via PaymentService)
Affected living context: PAYMENT-003 [ACTIVE] STANDARD, SEC-009 [ACTIVE] HARDENED
Review required: payment-team
Authority review: finance-team, security-team
```

Machine-readable output: append `--json` to `build`, `query`, `related`,
`trace`, `context`, `explain`, `owner`, `governed-by`, `impact`, `reviewers`,
`conflicts`, `health`. Run `nodenet --help` or `nodenet <command> --help` for
the full option reference.

## CLI reference

| Command | Description |
| --- | --- |
| `init` | Create `nodenet.config.json` and the `.nodenet/` directory |
| `build` | Scan, parse, analyze and persist the unified graph |
| `update` | Incremental rebuild from changed files (fingerprint-based) |
| `watch` | Rebuild on file changes |
| `query <name>` | Find nodes by name |
| `related <name>` | Show direct neighbors of a node |
| `trace <from> <to>` | Shortest explainable path between two nodes |
| `context [target]` | List contexts, build an AI context bundle, or `--propose <id>` a Context Change Proposal |
| `explain <name>` | A node and every relationship with provenance |
| `owner <path-or-symbol>` | Who owns a file or symbol (source + confidence) |
| `governed-by <name>` | Living contexts governing a node |
| `impact [--base <ref>]` | Analyze the current change (git diff) for impact |
| `reviewers [--base <ref>]` | Resolve reviewers (suggested / required / authorityRequired) |
| `conflicts` | List conflicting living contexts |
| `health` | Living context health report |
| `graph [-o <file>] [-f html\|svg]` | Generate an interactive HTML viewer or static SVG image with communities (default `.nodenet/graph.html`) |
| `doctor` | Validate config, graph and health |
| `github pr [options]` | Analyze a PR; post the impact comment and/or request reviewers (GitHub) |
| `mcp` | Run the MCP server over stdio for AI assistants |

## How governance is declared

Living context lives in `.nodenet/context.json` (or `.nodenet/contexts/*.json`),
aligned with the LCDD context schema:

```json
{
  "id": "PAYMENT-003",
  "version": 1,
  "title": "Settlement Processing Rule",
  "type": "domainRule",
  "status": "ACTIVE",
  "authority": "STANDARD",
  "appliesTo": ["src/payment/**"],
  "owner": "payment-team",
  "approvedBy": ["finance-team"],
  "provenance": { "source": "architecture-decision", "kind": "USER_DECLARED", "createdBy": "payment-team", "createdAt": "..." }
}
```

Ownership can come from:

1. **LCDD context metadata** (highest authority)
2. **NodeNet explicit ownership** — `.nodenet/ownership.json` + `nodenet.config.json` overrides
3. **CODEOWNERS**
4. **Git history** — *suggestion only*, never a required reviewer

See [docs/concepts/living-context.md](docs/concepts/living-context.md) for the
lifecycle (`DRAFT → CANDIDATE → APPROVED → ACTIVE → …`) and
[docs/concepts/ownership.md](docs/concepts/ownership.md) for the source ranking.

## Configuration

`nodenet init` writes a starter `nodenet.config.json`. Configuration is **data
only** — never executable code, and it is runtime-validated on every load:

```json
{
  "ignore": ["dist", "build", "coverage", ".next", "out"],
  "limits": {
    "maxFileSizeBytes": 1048576,
    "maxFiles": 10000,
    "maxGraphNodes": 100000,
    "maxGraphEdges": 300000
  },
  "reviewPolicy": { "LOW": "informational", "MEDIUM": "comment", "HIGH": "request", "CRITICAL": "approval" },
  "contextFreshness": { "architecture": "180d", "security": "90d", "businessRule": "180d", "default": "180d" },
  "ownership": {
    "teams": {
      "payment-team": { "name": "Payment Team" },
      "checkout-team": { "name": "Checkout Team" }
    },
    "overrides": []
  },
  "developer": { "handle": "your-gh-handle", "team": "checkout-team" }
}
```

Key sections: `ignore`, `limits` (resource limits that fail safely),
`reviewPolicy` (severity → action), `contextFreshness` (decay durations),
`ownership.teams` + `ownership.overrides`, `developer`, `secretPatterns` and
`suppressions`. Schema reference: [src/config/config.ts](src/config/config.ts).

## Security

- The repository is untrusted input. NodeNet never executes repository code.
- Paths are validated (`SafeRelativePath`) and symlink-escapes are rejected.
- Resource limits are configurable and fail safely.
- Secret-like files are never scanned; AI context output is secret-scanned.
- Git is invoked with argument arrays only (no shell concatenation).

See [SECURITY.md](SECURITY.md) and
[docs/security/threat-model.md](docs/security/threat-model.md).

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — layering, data flow, design decisions
- [docs/](docs/) — full documentation index
  - [docs/concepts/](docs/concepts/) — graph, living context, ownership, authority, change impact, review governance
  - [docs/adr/](docs/adr/) — architecture decision records (parser, runtime validation, graph storage)
  - [docs/security/threat-model.md](docs/security/threat-model.md)
- [SECURITY.md](SECURITY.md) — security guarantees and reporting
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute
- [CHANGELOG.md](CHANGELOG.md) — release history

## Testing

```bash
npm run typecheck
npm test
```

Fixtures cover basic TypeScript, React, a monorepo, the cross-team MVP scenario,
CODEOWNERS, circular dependencies, malformed source, and a malicious repository.
Property-based tests cover lifecycle transitions, traversal termination, glob
matching and path safety.

## Roadmap

- **Phase 1 (done):** code graph — `build`, `query`, `trace`, `related`
- **Phase 2 (done):** living context — `governed-by`, `conflicts`, `health`
- **Phase 3 (done):** ownership — `owner`
- **Phase 4 (done):** change impact — `impact` (symbol-level)
- **Phase 5 (done):** review governance — `reviewers`
- **Phase 6 (done):** GitHub integration — `github pr` (comment, review requests)
- **Phase 7 (done):** AI integration — MSC output + `mcp` server
- **Phase 8 (done):** richer visualization — interactive force-directed graph with communities (`graph`)
- Phase 9: multi-language parsing
- Phase 10: GitHub Action wrapper + merge-block policy

## GitHub pull-request integration

`nodenet github pr` runs inside a GitHub Actions checkout of the PR head and
produces the same deterministic impact + review report, optionally posting it:

```bash
nodenet github pr --repo owner/name --pr 42 --base main \
  --comment --request-reviewers
```

- `--comment` posts the impact + reviewers comment to the PR.
- `--request-reviewers` requests **declared** reviewers only (required +
  authority-required) — git-history suggestions are never auto-requested.
- Auth via `GITHUB_TOKEN` (least privilege: `contents: read`,
  `pull-requests: write`); `GITHUB_REPOSITORY` / `GITHUB_REF` /
  `GITHUB_BASE_REF` are read automatically in Actions.
- Design: [docs/adr/004-github-integration.md](docs/adr/004-github-integration.md).

## AI assistant integration (MCP)

`nodenet mcp` runs a Model Context Protocol server over stdio, exposing the
graph, living context, ownership, authority, impact and reviewers as tools for
AI coding assistants (Claude Code, Codex, and any MCP client):

```
nodenet mcp
```

Tools: `query`, `related`, `trace`, `context` (Minimum Sufficient Context —
secret-scanned), `explain`, `governed_by`, `owner`, `impact`, `reviewers`,
`health`, `graph`. All results are deterministic and provenance-backed.
Design: [docs/adr/005-mcp-server.md](docs/adr/005-mcp-server.md).

## License

Apache-2.0
