# Language support

NodeNet ships ten deterministic, local language adapters. `full` and `basic`
are explicit extraction contracts, not claims that every dynamic language
feature can be resolved statically.

| Language | Tier | Declarations | Imports | Visibility/exports | Methods | Inheritance | References |
| --- | --- | :---: | :---: | :---: | :---: | :---: | :---: |
| TypeScript | Full | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| JavaScript | Full | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Python | Full | ✅ | ✅ | ✅ | ✅ | — | — |
| Go | Full | ✅ | ✅ | ✅ | ✅ | — | — |
| Java | Full | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| C# | Full | ✅ | ✅ | ✅ | ✅ | — | — |
| PHP | Full | ✅ | ✅ | ✅ | ✅ | — | — |
| Rust | Basic | ✅ | ✅ | — | — | — | — |
| Ruby | Basic | ✅ | ✅ | — | — | — | — |
| Kotlin | Basic | ✅ | ✅ | — | — | — | — |

Full support means NodeNet understands the language's primary code structure,
visibility and methods well enough for symbol-level graph navigation. Basic
support provides file-level governance plus primary declarations and imports.
Unsupported or ambiguous dynamic dispatch is not silently promoted to an
extracted edge.

Inspect the runtime contract:

```bash
nodenet languages
nodenet languages --json
```

## Verification

Run `nodenet benchmark-languages` for positive and false-positive contracts
across all ten adapters. The report includes symbol precision/recall, import
recall, and exact failures per language. This is a regression baseline, not a
claim of compiler-semantic equivalence; real-repository labeled sampling is
still required before promoting a language tier.

`test/language-support.test.ts` runs one declaration-and-import contract test
for every listed language. Additional TypeScript/JavaScript, Python, Go, Java,
C#, PHP, artifact, impact, governance, security and property tests exercise
the graph built from those adapters.

The adapter API is public, so additional or more precise parsers can be
registered without changing the graph model:

```ts
import { registerLanguageAdapter } from "@antihero/nodenet";

registerLanguageAdapter(myAdapter);
```

## Usage by language

All adapters are selected automatically from the extension. There is no
language flag to maintain and mixed-language monorepos are supported.

| Language | Recognized files | What full/basic support is used for |
| --- | --- | --- |
| TypeScript | `.ts`, `.mts`, `.cts`, `.tsx` | symbols, imports/exports, calls/references, inheritance, React components/hooks |
| JavaScript | `.js`, `.mjs`, `.cjs`, `.jsx` | symbols, imports/exports, calls/references, inheritance, JSX components |
| Python | `.py` | modules/imports, classes, functions/methods, public/private naming visibility |
| Go | `.go` | imports, structs/interfaces, functions, receiver methods, exported-name visibility |
| Java | `.java` | imports, classes/interfaces/enums, methods, `extends` and `implements` |
| C# | `.cs` | `using` dependencies, classes/interfaces/enums, methods, public/private visibility |
| PHP | `.php` | `use` dependencies, classes/interfaces, methods/functions, public/private visibility |
| Rust | `.rs` | `use` dependencies and primary `fn`/`struct`/`trait`/`enum` declarations |
| Ruby | `.rb` | `require` dependencies and primary class/module/method declarations |
| Kotlin | `.kt` | imports and primary class/interface/object/function declarations |

Typical workflow is identical for every language:

```bash
cd your-repository
nodenet init
nodenet build
nodenet languages
nodenet query PaymentService
nodenet related PaymentService
nodenet explain PaymentService
nodenet graph --change --base main
nodenet impact --base main
nodenet reviewers --base main
```

For a mixed web repository containing TypeScript, C#, and PHP:

```text
frontend/src/checkout.ts       → TypeScript full adapter
services/Payments/Service.cs  → C# full adapter
legacy/PaymentController.php  → PHP full adapter
```

One `nodenet build` maps all three into the same graph. LCDD contexts and
ownership glob patterns can govern them together:

```yaml
applies_to:
  - frontend/src/payment/**
  - services/Payments/**
  - legacy/payment/**
```

## Accessing language results

The parsed graph is available through the same surfaces for every language:

| Access | Command/API | Best for |
| --- | --- | --- |
| Human CLI | `query`, `related`, `trace`, `explain`, `report` | exploration and debugging |
| Governance CLI | `governed-by`, `owner`, `impact`, `reviewers`, `changes` | change decisions and review policy |
| Machine-readable CLI | append `--json` where supported; `languages --json` | CI and scripts |
| Interactive HTML | `nodenet graph`, `nodenet graph --change --base main` | architecture, governance and change visualization |
| Static image | `nodenet graph -f svg -o graph.svg` | documentation and reports |
| MCP stdio | `nodenet mcp` | one local AI assistant |
| MCP HTTP | `nodenet serve --port 7341` | several local assistants sharing one graph |
| TypeScript API | `buildCodeGraph`, `languageSupportMatrix`, graph traversal exports | custom tooling and integrations |

Example MCP calls after starting `nodenet mcp` or `nodenet serve`:

- `query` — find a class/function from any supported language.
- `related` — inspect imports, declarations, governance and ownership edges.
- `trace` — find an explainable path between nodes.
- `context` — retrieve Minimum Sufficient Context for an agent.
- `impact` and `reviewers` — analyze the current git change.

## Known limits

- Dynamic dispatch, reflection, metaprogramming and runtime dependency
  injection cannot always be resolved statically.
- Basic adapters intentionally do not claim call/reference or visibility
  resolution.
- Full support describes NodeNet's current extraction contract; it does not
  mean complete compiler-semantic equivalence.
- Every uncertain future relation must be labeled `INFERRED` or `AMBIGUOUS`,
  never silently presented as extracted fact.
