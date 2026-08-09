import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/security/limits.js";
import { safeRelativePath } from "../src/security/filesystem.js";
import { languageAdapterFor, languageSupportMatrix } from "../src/parser/registry.js";
import { defaultConfig } from "../src/config/config.js";
import { buildCodeGraph } from "../src/analyzer/code-graph.js";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.js";

const cases = [
  { language: "typescript", file: "service.ts", source: "import { x } from './dep';\nexport class TypeScriptService {}", symbol: "TypeScriptService" },
  { language: "javascript", file: "service.js", source: "import x from './dep.js';\nexport function javascriptService() {}", symbol: "javascriptService" },
  { language: "python", file: "service.py", source: "import json\nclass PythonService:\n    def run(self): pass", symbol: "PythonService" },
  { language: "go", file: "service.go", source: "package service\nimport \"context\"\ntype GoService struct {}\nfunc Run() {}", symbol: "GoService" },
  { language: "java", file: "Service.java", source: "import java.util.List;\npublic class JavaService extends BaseService {\n public void run() {}\n}", symbol: "JavaService" },
  { language: "csharp", file: "Service.cs", source: "using System;\npublic class CSharpService { public void Run() {} }", symbol: "CSharpService" },
  { language: "php", file: "service.php", source: "<?php\nuse App\\Base;\nclass PhpService {\n public function run() {}\n}", symbol: "PhpService" },
  { language: "rust", file: "service.rs", source: "use std::sync::Arc;\nstruct RustService {}\nfn run() {}", symbol: "RustService" },
  { language: "ruby", file: "service.rb", source: "require 'json'\nclass RubyService\n def run\n end\nend", symbol: "RubyService" },
  { language: "kotlin", file: "Service.kt", source: "import kotlin.time.Duration\nclass KotlinService\nfun run() {}", symbol: "KotlinService" },
] as const;

describe("declared language support contract", () => {
  it.each(cases)("parses $language declarations and imports", ({ language, file, source, symbol }) => {
    const safe = safeRelativePath(file); if (!safe.ok) throw safe.error;
    const adapter = languageAdapterFor(safe.value);
    expect(adapter, `adapter for ${language}`).toBeDefined();
    const parsed = adapter?.parse(safe.value, source, DEFAULT_LIMITS); if (!parsed?.ok) throw parsed?.error;
    expect(parsed.value.language).toBe(language);
    expect(parsed.value.symbols.some((item) => item.name === symbol)).toBe(true);
    expect(parsed.value.imports.length).toBeGreaterThan(0);
  });

  it("publishes exactly seven full and three basic language contracts", () => {
    const matrix = languageSupportMatrix();
    expect(matrix.filter((item) => item.tier === "full")).toHaveLength(7);
    expect(matrix.filter((item) => item.tier === "basic")).toHaveLength(3);
    expect(new Set(matrix.map((item) => item.language)).size).toBe(10);
  });

  it("adds explicit cross-language relationships with config provenance", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "checkout.ts"), "export function checkout() {}\n");
    fs.writeFileSync(path.join(root, "src", "payment.py"), "def settle():\n    pass\n");
    const config = defaultConfig();
    config.relationships = [{ from: "checkout", to: "settle", relation: "calls", rationale: "HTTP payment request" }];
    const built = buildCodeGraph(root, config);
    if (!built.ok) throw built.error;
    const edge = [...built.value.graph.edges()].find((candidate) => candidate.relation === "calls");
    expect(edge?.provenance).toMatchObject({ source: "config", rationale: "HTTP payment request" });
  });
});
