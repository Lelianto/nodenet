# Contributing to NodeNet

Thank you for helping improve NodeNet. The project follows Living Context
Driven Development: code, decisions, ownership, and governance should evolve
together as reviewable, versioned artifacts.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Security vulnerabilities must be reported privately as described in
[SECURITY.md](SECURITY.md), not in a public issue.

## Before you start

- Search existing [issues](https://github.com/Lelianto/nodenet/issues) and pull
  requests before opening a duplicate.
- For a focused bug fix or documentation correction, a pull request is welcome
  directly.
- For a large feature, public API change, new dependency, persistence-format
  change, or architectural change, open an issue first so scope and trade-offs
  can be agreed before implementation.
- Keep pull requests focused. Unrelated refactors make governance and security
  review harder.

## Development setup

Requirements: Node.js 20 or 22 and git.

```bash
git clone https://github.com/Lelianto/nodenet.git
cd nodenet
npm ci
npm run typecheck
npm test
npm run build
```

Use `npm ci` for a reproducible checkout. If you intentionally change a
dependency, use `npm install` and commit the resulting `package-lock.json`
change with an explanation.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check strict TypeScript types without emitting files |
| `npm test` | Run the full Vitest suite once |
| `npm run test:watch` | Run tests interactively while developing |
| `npm run build` | Compile the package to `dist/` |
| `npm run prepublishOnly` | Run the complete release verification sequence |

Generated output such as `dist/`, coverage data, and most `.nodenet/` runtime
state is ignored and should not be committed unless a fixture or documented
artifact explicitly requires it.

## Engineering conventions

- Keep analysis deterministic: identical repository state and configuration
  must produce identical decisions.
- Treat repository files, configuration, persisted graph data, git metadata,
  and remote API responses as untrusted input.
- Use TypeScript strict mode. Prefer `unknown` plus validation or narrowing to
  `any`.
- Use branded identifiers (`NodeId`, `ContextId`, `TeamId`, and similar),
  discriminated unions, and exhaustive switches for domain models.
- Use `Result<T, E>` or explicit domain errors for expected failures. Avoid
  silently swallowing invalid data.
- Invoke external commands with argument arrays. Never interpolate repository
  content into a shell command.
- Preserve resource limits, path-containment checks, provenance, and
  explainable output when adding a parser or integration.
- Avoid new runtime dependencies unless the benefit and security/maintenance
  cost are justified in the pull request.

See [ARCHITECTURE.md](ARCHITECTURE.md) for module boundaries and
[docs/security/threat-model.md](docs/security/threat-model.md) for the trust
model.

## Tests and fixtures

Add or update tests for every behavioral change. Fixtures live under
`test/fixtures/`; keep them minimal and describe the scenario through the test
name and assertions.

Changes at an external boundary should cover both valid and malformed input.
Security-sensitive changes should include regression tests for containment,
resource exhaustion, secret handling, authorization, or command injection as
applicable. Parser changes should preserve the documented language capability
contract in [docs/languages.md](docs/languages.md).

Before submitting a pull request, run:

```bash
npm run typecheck
npm test
npm run build
```

CI runs the same checks on Node.js 20 and 22.

## Documentation and decisions

Update documentation in the same pull request as behavior:

- user-visible commands, flags, or workflows: `README.md` and relevant docs;
- architecture or module boundaries: `ARCHITECTURE.md`;
- notable user-visible changes: the `[Unreleased]` section of `CHANGELOG.md`;
- security assumptions or controls: `SECURITY.md` and the threat model;
- durable architectural decisions: a numbered ADR in `docs/adr/`.

Add new documents to [docs/README.md](docs/README.md) so they remain
discoverable. Do not include tokens, credentials, private evaluation data, or
customer/repository source in issues, fixtures, logs, screenshots, or commits.

## Pull requests

A pull request should explain the problem, the chosen approach, tests run, and
any compatibility, security, or governance impact. Link the related issue when
one exists. Mark breaking changes clearly.

A change is ready to merge when:

- implementation and error handling are complete;
- strict types and runtime validation cover relevant boundaries;
- tests pass and include appropriate regression coverage;
- output remains deterministic and explainable;
- security and resource-limit implications have been considered;
- documentation and the changelog are current;
- no placeholders, fabricated data, or fake benchmarks remain.

Maintainers may request changes, split an oversized pull request, or decline a
proposal that conflicts with the project scope or security model.

## Where to look

- [README.md](README.md) — product overview and CLI usage
- [ARCHITECTURE.md](ARCHITECTURE.md) — data flow, modules, and invariants
- [docs/README.md](docs/README.md) — concepts, ADRs, operations, and security
- [SECURITY.md](SECURITY.md) — supported versions and private reporting
- [CHANGELOG.md](CHANGELOG.md) — release history
