# NodeNet Roadmap

> Development plan to reach feature parity with leading code-graph tools and
> then pull ahead on what makes NodeNet unique: governance that can be
> *enforced*, deterministically, in CI.

## Positioning

**Graph tools help AI *understand* code. NodeNet also governs how code may
change.** The roadmap closes the reach/feature gaps first (so NodeNet is a
real alternative everywhere), then doubles down on the governance moat that
nobody else combines: deterministic reviewers, merge policy, AI-safety, and
security.

## Gap audit — where NodeNet stands vs. leading code-graph tools

| Capability | NodeNet today | Target |
| --- | --- | --- |
| Local, deterministic parsing (no LLM, no vector store) | ✅ | ✅ |
| Interactive visualization + communities | ✅ | ✅ |
| AI / MCP integration | ✅ stdio + loopback-first HTTP | authentication and team hardening |
| Multi-language parsing | ✅ 10 languages: 7 full + 3 basic | deeper semantic resolution per adapter |
| Assistant skill install | ✅ Codex, Claude, Cursor, Agent Skills | additional platforms |
| Auto-generated report (god nodes, surprising connections, suggested questions) | ✅ `nodenet report` | ✅ |
| PR dashboard + merge-order conflict detection | ✅ local multi-ref `changes` | hosted dashboard |
| Docs / markdown / ADR ingestion as graph nodes | ✅ ADR/OpenAPI/SQL/Terraform | richer cross-links |
| Git hook auto-rebuild + graph.json merge driver | ❌ | ✅ |
| Decision benchmark harness | ✅ labeled metrics + CI-ready JSON | publish real pilot results |
| README translations | 1 language | multiple |

## Round 1 — distribution & reach (low→medium effort, high impact)

1. **`nodenet install`** — register the tool with AI assistants (Claude Code,
   Codex, Cursor, Gemini, OpenCode, …): install skill + `AGENTS.md` +
   hooks/rules so assistants query the graph first instead of grepping files.
   *Highest distribution impact.*
2. **MCP over HTTP** — a shared MCP server for teams (in addition to stdio),
   so one process serves the graph for the whole team.
3. **`nodenet report`** — auto-generate a markdown highlights report
   (done — Round 1 quick win):
   - *god nodes* (highest-degree symbols),
   - *surprising connections* (cross-community / far-file links),
   - *suggested questions* the graph is positioned to answer,
   - community summary + governance overview.
4. **README translations** — low effort, high visibility (ID, CN, JA, DE, …).
5. **Git hook + merge driver** — auto-rebuild graph on commit and merge
   `.nodenet/graph.json` conflict-free so teams can commit the graph.

## Round 2 — core feature gaps

6. **Multi-language parsing (Phase 9, done)** — ten deterministic local
   adapters: full TypeScript, JavaScript, Python, Go, Java, C#, PHP; basic
   Rust, Ruby and Kotlin. Future work deepens semantic resolution without
   changing the public adapter contract.
7. **Docs / ADR ingestion** — treat markdown, ADRs, RFCs, and inline rationale
   comments as first-class context nodes linked to the code they govern.
   Aligns with Living Context Driven Development (LCDD).
8. **`nodenet prs`** — PR dashboard: CI state, review status, per-PR graph
   impact, and `--conflicts` (two PRs touching the same communities = merge
   order risk).

## Round 3 — the moat: exceed, don't copy

9. **GitHub Action wrapper + merge-block policy (Phase 10, done)** — automatically
   flag or block a PR that changes code governed by HARDENED/MANDATORY context
   without the required approval. *The headline differentiator in CI.*
10. **Decision benchmarks (harness done; real results validation-gated)** —
    labeled reviewer precision/recall, false-block, missed-impact, accuracy and
    p50/p95 metrics. Publish results only after design-partner labeling.
11. **VSCode extension** — hover a symbol to see owner, governed-by context,
    and change severity inline.
12. **Governance AI-gating end-to-end** — Context Change Proposals that can be
    approved/rejected through a bot or UI, with the full audit trail.

## Startup validation gate

The local product now includes deterministic decision IDs, append-only audit
events, expiring overrides, idempotent GitHub checks/comments, merge-queue
support, `bootstrap`, readiness `doctor`, benchmark scoring, and a pilot
playbook. The next work is evidence gathering with three design partners—not
immediate SaaS breadth.

Organization installation, multi-repository governance, centralized Contexts,
identity mapping, audit/history UI, signed export, notifications, and billing
remain gated until three partners use the loop weekly and two commit to a paid
pilot.

## Strategy

Don't copy the incumbents wholesale. The combination no one else offers:

- **Deterministic and enforceable** — reviewers + merge-block in CI, not just
  a dashboard or an AI guess.
- **Security-aware** — never executes repository code, secret-scans AI output,
  argument-array git, least-privilege tokens.
- **Governance by rank** — LCDD context > explicit ownership > CODEOWNERS >
  git-history (inference never required).

### Recommended order

1. `nodenet install` + MCP HTTP (distribution impact, fastest)
2. Multi-language parsing (biggest feature gap)
3. GitHub Action merge-block (the CI differentiator)
