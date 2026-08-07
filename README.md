<p align="center">
  <img src="docs/logo.svg" alt="NodeNet" width="320" />
</p>

<p align="center">
  <strong>Know what changes. Know what it affects. Know who should review it.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@antihero/nodenet"><img src="https://img.shields.io/npm/v/@antihero/nodenet?logo=npm&label=version" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@antihero/nodenet"><img src="https://img.shields.io/npm/dm/@antihero/nodenet" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@antihero/nodenet" alt="license" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js" alt="Node.js >= 18" /></a>
  <a href="tsconfig.json"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript" alt="TypeScript strict" /></a>
  <a href="https://github.com/Lelianto/nodenet/actions"><img src="https://img.shields.io/github/actions/workflow/status/Lelianto/nodenet/ci.yml?label=ci" alt="CI" /></a>
  <a href="https://github.com/Lelianto/nodenet"><img src="https://img.shields.io/github/stars/Lelianto/nodenet?style=social" alt="GitHub stars" /></a>
</p>

AI coding agents can understand code. But software is more than code —
architecture decisions, business rules, ownership boundaries, security
policies, and team responsibilities determine whether a change should be made
and who should review it.

**NodeNet maps code, living context, ownership and authority into one
explainable graph, then answers deterministically what a change breaks and who
must review it** — locally, with no AI, no vector store, and nothing leaving
your machine.

```
CODE          →  CONTEXT      →  OWNERSHIP  →  AUTHORITY   →  CHANGE IMPACT  →  REVIEW
files, calls,     living rules,   who owns      who approves   what breaks,     who must
symbols, deps     governance      the code      hardened       what is affected  review it
```

It is the practical reference implementation of **Living Context Driven
Development (LCDDD)** — context treated as a living, versioned, governed
artifact ([living-context-driven-development](https://github.com/Lelianto/living-context-driven-development)).

---

## Contents

- [What it does](#what-it-does)
- [The problem it solves](#the-problem-it-solves)
- [How it works](#how-it-works)
- [See it in action](#see-it-in-action)
- [Why NodeNet (vs Graphify & co)](#why-nodenet-vs-graphify--co)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [How governance is declared](#how-governance-is-declared)
- [Configuration](#configuration)
- [GitHub pull-request integration](#github-pull-request-integration)
- [AI assistant integration (MCP)](#ai-assistant-integration-mcp)
- [Team setup](#team-setup)
- [Example project](#example-project)
- [Security & privacy](#security--privacy)
- [Documentation](#documentation)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [Troubleshooting & FAQ](#troubleshooting--faq)
- [License](#license)

---

## What it does

| Capability | What you get |
| --- | --- |
| **Explainable code graph** | Typed nodes + edges with provenance — every connection says *why* it exists |
| **Living context** | Rules (business, security, compliance) as versioned artifacts with a lifecycle and freshness decay |
| **Ownership & authority** | Who owns code, who approves changes, ranked from LCDD > NodeNet > CODEOWNERS > git history |
| **Change impact** | A git diff becomes a symbol-level report: severity, affected code, ownership boundaries |
| **Review governance** | Deterministic reviewers: `suggested` / `required` / `authorityRequired`, deduplicated, with reasons |
| **AI context bundles (MSC)** | Minimum Sufficient Context for AI agents, secret-scanned, provenance-marked |
| **MCP server** | The whole graph as MCP tools for Claude Code, Codex, and any MCP client |
| **GitHub PR integration** | Post the impact comment and request reviewers on a PR |
| **Interactive visualization** | Force-directed `graph.html` with communities, search, and filters — plus static SVG export |
| **Local-first & deterministic** | No LLM, no vector store, no network, no code execution; identical output for identical input |

## The problem it solves

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

## See it in action

Real output from the [example project](examples/payments-demo):

```
$ nodenet owner src/payment/PaymentService.ts
src/payment/PaymentService.ts → payment-team (source: lcdd, confidence: AUTHORITATIVE)

$ nodenet trace runCheckout saveSettlement
runCheckout() @ src/checkout/CheckoutFlow.ts:10
  --calls--> checkout() @ src/checkout/CheckoutService.ts:4
  --calls--> createSettlement() @ src/payment/PaymentService.ts:4
  --calls--> saveSettlement() @ src/payment/SettlementRepository.ts:3

$ nodenet governed-by src/payment/PaymentService.ts
Contexts governing src/payment/PaymentService.ts:
  PAYMENT-003 [ACTIVE] STANDARD — Settlement Processing Rule (approvers: finance-team)
  SEC-009 [ACTIVE] HARDENED — PCI Payment Data Validation (approvers: security-team)

$ nodenet impact --base main
Impact: HIGH
Ownership boundary crossed: checkout-team → payment-team (via PaymentService)
Affected living context: PAYMENT-003 [ACTIVE] STANDARD, SEC-009 [ACTIVE] HARDENED
Review required: payment-team
Authority review: finance-team, security-team

$ nodenet reviewers --base main
Authority approval required:
  finance-team
    because: PAYMENT-003 requires approval from finance-team (STANDARD, status ACTIVE)
  security-team
    because: SEC-009 requires approval from security-team (HARDENED, status ACTIVE)
```

Open the [interactive graph](examples/payments-demo/.nodenet/graph.html) from the
example project to explore it visually: pan/zoom, hover, click nodes, search,
and filter by layer.

## Why NodeNet (vs Graphify & co)

Code-graph tools such as [Graphify](https://github.com/Graphify-Labs/graphify)
excel at *understanding* a codebase — mapping code/docs into a queryable graph
for AI assistants. NodeNet does that too, but its focus is the other half of
the job: **governing how code changes**.

| | NodeNet | Graphify & code-graph tools |
| --- | --- | --- |
| Local, deterministic code graph (no LLM, no vector store) | ✅ | ✅ |
| Interactive visualization + communities | ✅ | ✅ |
| AI / MCP integration | ✅ | ✅ |
| **Living context as governed, versioned artifacts** | ✅ | ⚠️ passive extraction only |
| **Ownership ranking (LCDD > NodeNet > CODEOWNERS)** | ✅ | ❌ |
| **Authority levels + lifecycle (DRAFT → ACTIVE → ARCHIVED)** | ✅ | ❌ |
| **Symbol-level change impact + severity** | ✅ | partial (PR dashboard) |
| **Deterministic reviewer resolution with reasons** | ✅ | ❌ (AI triage) |
| **Merge-policy gating on hardened/mandatory rules** | ✅ | ❌ |
| **AI context bundles, secret-scanned** | ✅ | ❌ |
| Multi-language parsing | TS/JS (planned: more) | 36+ |
| Docs/PDFs/media ingestion | planned | ✅ |

**NodeNet is the governance layer for AI-driven development.** It answers
*"who decides, and what may an AI agent change?"* — not just *"what is
connected?"* It treats rules as living, owned, approved artifacts, and it can
automate review requests and CI gating from that governance. Graphify helps AI
understand code; NodeNet helps teams keep code changeable, safely.

## Requirements

| Requirement | Minimum | Check |
| --- | --- | --- |
| Node.js | 18+ | `node --version` |
| git | any | `git --version` (needed for `impact` / `reviewers` / `update`) |

## Install

```bash
npm install -g @antihero/nodenet     # from npm
```

Or from source:

```bash
git clone https://github.com/Lelianto/nodenet.git
cd nodenet
npm install
npm run build
```

Then run it inside any repository you want to map:

```bash
nodenet init      # creates nodenet.config.json + .nodenet/
nodenet build     # scan, parse, analyze, persist the unified graph
nodenet graph     # interactive visualization (.nodenet/graph.html)
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
nodenet graph                                 # interactive HTML visualization
nodenet graph -f svg -o graph.svg             # static SVG image
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
| `graph [-o <file>] [-f html\|svg]` | Generate an interactive HTML viewer or static SVG image with communities |
| `doctor` | Validate config, graph and health |
| `github pr [options]` | Analyze a PR; post the impact comment and/or request reviewers |
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

```bash
nodenet mcp
```

Tools: `query`, `related`, `trace`, `context` (Minimum Sufficient Context —
secret-scanned), `explain`, `governed_by`, `owner`, `impact`, `reviewers`,
`health`, `graph`. All results are deterministic and provenance-backed.
Design: [docs/adr/005-mcp-server.md](docs/adr/005-mcp-server.md).

## Team setup

NodeNet artifacts are meant to be committed so every developer and CI runner
starts with the same map:

```
# commit these
.nodenet/context.json      # authored living context
.nodenet/ownership.json    # authored explicit ownership
nodenet.config.json        # review policy, teams, limits
.nodenet/graph.html        # interactive visualization
```

Recommended workflow:

1. One person runs `nodenet init` + `nodenet build` and commits the artifacts.
2. Everyone pulls — `query`/`trace`/`impact` work immediately.
3. `nodenet impact --base main` runs in CI on every PR (and `github pr` posts
   the comment and requests reviewers).
4. When rules change, edit `.nodenet/context.json` and commit — the lifecycle
   and audit log keep the change explainable.

The [example project](examples/payments-demo) demonstrates the whole flow.

## Example project

See [examples/payments-demo](examples/payments-demo) — a ready-made checkout →
payment project with living context, ownership, authority and a cross-team PR
scenario. It ships a pre-built interactive
[graph.html](examples/payments-demo/.nodenet/graph.html) and a
[README](examples/payments-demo/README.md):

```bash
npm run build
cd examples/payments-demo
./demo.sh          # build, visualize, query, impact + reviewers
```

## Security & privacy

- The repository is untrusted input. NodeNet never executes repository code.
- Paths are validated (`SafeRelativePath`) and symlink-escapes are rejected.
- Resource limits are configurable and fail safely.
- Secret-like files are never scanned; AI context output is secret-scanned.
- Git is invoked with argument arrays only (no shell concatenation).
- Fully local: no telemetry, no network calls, no data leaves your machine.
- Least-privilege GitHub integration (`contents: read`, `pull-requests: write`).

See [SECURITY.md](SECURITY.md) and
[docs/security/threat-model.md](docs/security/threat-model.md).

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — layering, data flow, design decisions
- [docs/](docs/) — full documentation index
  - [docs/concepts/](docs/concepts/) — graph, living context, ownership, authority, change impact, review governance
  - [docs/adr/](docs/adr/) — architecture decision records (parser, runtime validation, graph storage, GitHub, MCP, visualization)
  - [docs/security/threat-model.md](docs/security/threat-model.md)
- [SECURITY.md](SECURITY.md) — security guarantees and reporting
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute
- [CHANGELOG.md](CHANGELOG.md) — release history

## Testing

```bash
npm run typecheck
npm test
```

94 tests across 11 suites. Fixtures cover basic TypeScript, React, a monorepo,
the cross-team MVP scenario, CODEOWNERS, circular dependencies, malformed
source, and a malicious repository. Property-based tests cover lifecycle
transitions, traversal termination, glob matching and path safety. CI runs on
Node 18, 20 and 22.

## Roadmap

- **Phase 1 (done):** code graph — `build`, `query`, `trace`, `related`
- **Phase 2 (done):** living context — `governed-by`, `conflicts`, `health`
- **Phase 3 (done):** ownership — `owner`
- **Phase 4 (done):** change impact — `impact` (symbol-level)
- **Phase 5 (done):** review governance — `reviewers`
- **Phase 6 (done):** GitHub integration — `github pr` (comment, review requests)
- **Phase 7 (done):** AI integration — MSC output + `mcp` server
- **Phase 8 (done):** richer visualization — interactive force-directed graph with communities (`graph`, `graph -f svg`)
- Phase 9: multi-language parsing
- Phase 10: GitHub Action wrapper + merge-block policy
- Phase 11: docs/PDF ingestion + richer AI (optional LLM backends)

## Troubleshooting & FAQ

**`nodenet: command not found`**
The bin directory isn't on your `PATH`. With npm global installs on macOS,
ensure `$(npm config get prefix)/bin` is in your `PATH`, then open a new
terminal.

**`impact` says "Not inside a git repository"**
`impact`/`reviewers` need a git checkout and a base ref. Run `nodenet impact --base main`
inside the repo, or use `nodenet build` + `nodenet query` which don't need git.

**The graph.html canvas looks empty**
Hard-reload (Cmd/Ctrl+Shift+R). Node labels only render when zoomed in enough
(`scale > 0.45`) — scroll to zoom. If it still renders nothing, open it in a
current Chrome/Firefox.

**Why is the package name `@antihero/nodenet`?**
The unscoped name `nodenet` is blocked on npm as too similar to an existing
package. The CLI command is still `nodenet`.

**How do I change a hardened context?**
You can't silently. Run `nodenet context propose <id>` to record a Context
Change Proposal; it never modifies the active context and requires human
review and approval.

**What if my repo is not TypeScript?**
Current support is TS/TSX/JS/JSX. Governance (context, ownership, authority)
works on any repo; code parsing for other languages is on the roadmap
(Phase 9).

## License

[Apache-2.0](LICENSE)
