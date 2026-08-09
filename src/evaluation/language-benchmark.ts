/** Reproducible, engine-executed contract benchmark for every built-in language adapter. */
import { DEFAULT_LIMITS } from "../security/limits.js";
import { safeRelativePath } from "../security/filesystem.js";
import { languageAdapterFor } from "../parser/registry.js";

export interface LanguageBenchmarkCase {
  id: string;
  language: string;
  file: string;
  source: string;
  expectedSymbols: string[];
  forbiddenSymbols?: string[];
  minimumImports: number;
}

export interface LanguageBenchmarkRow {
  language: string;
  cases: number;
  passed: number;
  symbolPrecision: number;
  symbolRecall: number;
  importRecall: number;
  failures: string[];
}

export interface LanguageBenchmarkReport { cases: number; passed: number; passRate: number; languages: LanguageBenchmarkRow[] }

export function runLanguageBenchmark(cases: LanguageBenchmarkCase[] = BUILTIN_LANGUAGE_BENCHMARK): LanguageBenchmarkReport {
  const grouped = new Map<string, LanguageBenchmarkRow & { tp: number; predicted: number; expected: number; importHits: number; importExpected: number }>();
  for (const item of cases) {
    const row = grouped.get(item.language) ?? { language: item.language, cases: 0, passed: 0, symbolPrecision: 0, symbolRecall: 0, importRecall: 0, failures: [], tp: 0, predicted: 0, expected: 0, importHits: 0, importExpected: 0 };
    row.cases++;
    const safe = safeRelativePath(item.file);
    if (!safe.ok) { row.failures.push(`${item.id}: unsafe fixture path`); grouped.set(item.language, row); continue; }
    const adapter = languageAdapterFor(safe.value);
    const parsed = adapter?.parse(safe.value, item.source, DEFAULT_LIMITS);
    if (!adapter || !parsed?.ok) { row.failures.push(`${item.id}: parse failed`); grouped.set(item.language, row); continue; }
    const actual = new Set(parsed.value.symbols.map((symbol) => symbol.name));
    const expected = new Set(item.expectedSymbols);
    const forbidden = new Set(item.forbiddenSymbols ?? []);
    const truePositive = [...actual].filter((name) => expected.has(name)).length;
    row.tp += truePositive;
    row.predicted += actual.size;
    row.expected += expected.size;
    row.importExpected += item.minimumImports;
    row.importHits += Math.min(item.minimumImports, parsed.value.imports.length);
    const missing = [...expected].filter((name) => !actual.has(name));
    const falsePositive = [...forbidden].filter((name) => actual.has(name));
    const importMissing = parsed.value.imports.length < item.minimumImports;
    if (missing.length || falsePositive.length || importMissing) row.failures.push(`${item.id}: ${missing.length ? `missing ${missing.join(", ")}` : ""}${falsePositive.length ? ` forbidden ${falsePositive.join(", ")}` : ""}${importMissing ? ` imports ${parsed.value.imports.length}/${item.minimumImports}` : ""}`.trim());
    else row.passed++;
    grouped.set(item.language, row);
  }
  const languages = [...grouped.values()].map((row) => ({
    language: row.language, cases: row.cases, passed: row.passed,
    symbolPrecision: ratio(row.tp, row.predicted), symbolRecall: ratio(row.tp, row.expected), importRecall: ratio(row.importHits, row.importExpected), failures: row.failures,
  })).sort((a, b) => a.language.localeCompare(b.language));
  const passed = languages.reduce((sum, row) => sum + row.passed, 0);
  return { cases: cases.length, passed, passRate: ratio(passed, cases.length), languages };
}

function ratio(n: number, d: number): number { return d === 0 ? 1 : Number((n / d).toFixed(4)); }

export const BUILTIN_LANGUAGE_BENCHMARK: LanguageBenchmarkCase[] = [
  { id: "ts-structure", language: "typescript", file: "src/service.ts", source: "import { Base } from './base'; export class Service extends Base { run() {} }", expectedSymbols: ["Service", "Service.run"], minimumImports: 1 },
  { id: "ts-comment", language: "typescript", file: "src/comment.ts", source: "// function Ghost() {}\nexport function Real() {}", expectedSymbols: ["Real"], forbiddenSymbols: ["Ghost"], minimumImports: 0 },
  { id: "js-structure", language: "javascript", file: "src/service.js", source: "import dep from './dep.js'; export function run() { return dep(); }", expectedSymbols: ["run"], minimumImports: 1 },
  { id: "js-string", language: "javascript", file: "src/string.js", source: "const text = 'class Ghost {}'; export class Real {}", expectedSymbols: ["text", "Real"], forbiddenSymbols: ["Ghost"], minimumImports: 0 },
  { id: "py-structure", language: "python", file: "service.py", source: "from base import Base\nclass Service(Base):\n    def run(self): pass", expectedSymbols: ["Service", "run"], minimumImports: 1 },
  { id: "py-comment", language: "python", file: "comment.py", source: "# def ghost(): pass\ndef real(): pass", expectedSymbols: ["real"], forbiddenSymbols: ["ghost"], minimumImports: 0 },
  { id: "go-structure", language: "go", file: "service.go", source: "package x\nimport \"context\"\ntype Service struct{}\nfunc (s Service) Run() {}", expectedSymbols: ["Service", "Run"], minimumImports: 1 },
  { id: "go-comment", language: "go", file: "comment.go", source: "package x\n// func Ghost() {}\nfunc Real() {}", expectedSymbols: ["Real"], forbiddenSymbols: ["Ghost"], minimumImports: 0 },
  { id: "java-structure", language: "java", file: "Service.java", source: "import java.util.List; public class Service extends Base { public void run() {} }", expectedSymbols: ["Service"], minimumImports: 1 },
  { id: "java-comment", language: "java", file: "Real.java", source: "// class Ghost {}\npublic class Real {}", expectedSymbols: ["Real"], forbiddenSymbols: ["Ghost"], minimumImports: 0 },
  { id: "cs-structure", language: "csharp", file: "Service.cs", source: "using System;\npublic class Service { public void Run() {} }", expectedSymbols: ["Service"], minimumImports: 1 },
  { id: "cs-comment", language: "csharp", file: "Real.cs", source: "// class Ghost {}\npublic class Real {}", expectedSymbols: ["Real"], forbiddenSymbols: ["Ghost"], minimumImports: 0 },
  { id: "php-structure", language: "php", file: "service.php", source: "<?php\nuse App\\Base;\nclass Service { public function run() {} }", expectedSymbols: ["Service"], minimumImports: 1 },
  { id: "php-comment", language: "php", file: "real.php", source: "<?php\n// class Ghost {}\nclass Real {}", expectedSymbols: ["Real"], forbiddenSymbols: ["Ghost"], minimumImports: 0 },
  { id: "rust-structure", language: "rust", file: "service.rs", source: "use std::sync::Arc;\nstruct Service {}\nfn run() {}", expectedSymbols: ["Service", "run"], minimumImports: 1 },
  { id: "rust-comment", language: "rust", file: "real.rs", source: "// fn ghost() {}\nfn real() {}", expectedSymbols: ["real"], forbiddenSymbols: ["ghost"], minimumImports: 0 },
  { id: "ruby-structure", language: "ruby", file: "service.rb", source: "require 'json'\nclass Service\n def run\n end\nend", expectedSymbols: ["Service", "run"], minimumImports: 1 },
  { id: "ruby-comment", language: "ruby", file: "real.rb", source: "# def ghost\ndef real\nend", expectedSymbols: ["real"], forbiddenSymbols: ["ghost"], minimumImports: 0 },
  { id: "kotlin-structure", language: "kotlin", file: "Service.kt", source: "import kotlin.time.Duration\nclass Service\nfun run() {}", expectedSymbols: ["Service", "run"], minimumImports: 1 },
  { id: "kotlin-comment", language: "kotlin", file: "Real.kt", source: "// class Ghost\nclass Real", expectedSymbols: ["Real"], forbiddenSymbols: ["Ghost"], minimumImports: 0 },
];
