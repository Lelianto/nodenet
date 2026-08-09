/** Conservative Python and Go declaration/import extraction without executing code. */
import type { Limits } from "../security/limits.js";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { LanguageAdapter } from "./registry.js";
import type { Language, ParsedFile, ParsedImport, ParsedSymbol } from "./typescript.js";

const STRUCTURAL_FULL = ["declarations", "imports", "exports", "methods"] as const;
const BASIC = ["declarations", "imports"] as const;

function symbol(kind: ParsedSymbol["kind"], name: string, line: number, exported = true): ParsedSymbol {
  return { kind, name, startLine: line, endLine: line, exported, isDefault: false, references: [], jsxRefs: [], heritage: [] };
}

function bounded(content: string, limits: Limits): Result<string[], Error> {
  if (Buffer.byteLength(content, "utf8") > limits.maxFileSizeBytes) return err(new Error("Source exceeds parse limit."));
  return ok(content.split("\n"));
}

export const pythonAdapter: LanguageAdapter = {
  id: "python-local",
  languages: ["python"], tier: "full", capabilities: STRUCTURAL_FULL,
  supports: (file) => file.toString().endsWith(".py"),
  parse(file, content, limits): Result<ParsedFile, Error> {
    const input = bounded(content, limits); if (!input.ok) return input;
    const symbols: ParsedSymbol[] = []; const imports: ParsedImport[] = [];
    input.value.forEach((line, index) => {
      const declaration = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
      const klass = line.match(/^\s*class\s+([A-Za-z_]\w*)/);
      const fromImport = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)/);
      const directImport = line.match(/^\s*import\s+([\w.]+)/);
      if (declaration?.[1]) symbols.push(symbol(line.startsWith(" ") ? "method" : "function", declaration[1], index + 1, !declaration[1].startsWith("_")));
      if (klass?.[1]) symbols.push(symbol("class", klass[1], index + 1, !klass[1].startsWith("_")));
      if (fromImport?.[1] && fromImport[2]) imports.push({ specifier: fromImport[1], bindings: fromImport[2].split(",").map((name) => ({ local: name.trim().split(/\s+as\s+/).pop() ?? name.trim() })) });
      else if (directImport?.[1]) imports.push({ specifier: directImport[1], bindings: [] });
    });
    return ok({ path: file, language: "python", symbols, imports, reexports: [], exportedLocalNames: [], hasSyntaxErrors: false });
  },
};

export const goAdapter: LanguageAdapter = {
  id: "go-local",
  languages: ["go"], tier: "full", capabilities: STRUCTURAL_FULL,
  supports: (file) => file.toString().endsWith(".go"),
  parse(file, content, limits): Result<ParsedFile, Error> {
    const input = bounded(content, limits); if (!input.ok) return input;
    const symbols: ParsedSymbol[] = []; const imports: ParsedImport[] = [];
    input.value.forEach((line, index) => {
      const fn = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/);
      const type = line.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/);
      const imp = line.match(/^\s*(?:[\w.]+\s+)?"([^"]+)"\s*$/);
      if (fn?.[1]) symbols.push(symbol(/^func\s+\(/.test(line) ? "method" : "function", fn[1], index + 1, /^[A-Z]/.test(fn[1])));
      if (type?.[1]) symbols.push(symbol(type[2] === "interface" ? "interface" : "class", type[1], index + 1, /^[A-Z]/.test(type[1])));
      if (imp?.[1]) imports.push({ specifier: imp[1], bindings: [] });
    });
    return ok({ path: file, language: "go", symbols, imports, reexports: [], exportedLocalNames: [], hasSyntaxErrors: false });
  },
};

export const javaAdapter: LanguageAdapter = {
  id: "java-local", languages: ["java"], tier: "full", capabilities: ["declarations", "imports", "exports", "methods", "inheritance"],
  supports: (file) => file.toString().endsWith(".java"),
  parse(file, content, limits) {
    const parsed = parsePatternLanguage(file, content, limits, "java", {
      imports: [/^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/],
      declarations: [
        { regex: /\bclass\s+([A-Za-z_]\w*)/, kind: "class" },
        { regex: /\binterface\s+([A-Za-z_]\w*)/, kind: "interface" },
        { regex: /\benum\s+([A-Za-z_]\w*)/, kind: "enum" },
        { regex: /\b(?:public|protected|private|static|final|synchronized|native|abstract|\s)+[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\(/, kind: "method" },
      ],
    });
    if (!parsed.ok) return parsed;
    for (const line of content.split("\n")) {
      const declaration = line.match(/\b(class|interface)\s+([A-Za-z_]\w*)\s*(?:extends\s+([\w.]+))?\s*(?:implements\s+([\w.,\s]+))?/);
      const target = parsed.value.symbols.find((item) => item.name === declaration?.[2]);
      if (!target) continue;
      if (declaration?.[3]) target.heritage.push({ name: declaration[3], relation: "extends" });
      if (declaration?.[4]) for (const name of declaration[4].split(",").map((item) => item.trim()).filter(Boolean)) target.heritage.push({ name, relation: "implements" });
    }
    return parsed;
  },
};

interface PatternSpec { regex: RegExp; kind: ParsedSymbol["kind"] }
interface PatternLanguage { imports: RegExp[]; declarations: PatternSpec[] }

function parsePatternLanguage(file: ParsedFile["path"], content: string, limits: Limits, language: Language, patterns: PatternLanguage): Result<ParsedFile, Error> {
  const input = bounded(content, limits); if (!input.ok) return input;
  const symbols: ParsedSymbol[] = []; const imports: ParsedImport[] = [];
  input.value.forEach((line, index) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
    for (const regex of patterns.imports) { const found = line.match(regex)?.[1]; if (found) { imports.push({ specifier: found, bindings: [] }); break; } }
    for (const declaration of patterns.declarations) { const name = line.match(declaration.regex)?.[1]; if (name) { symbols.push(symbol(declaration.kind, name, index + 1, !name.startsWith("_") && !/\bprivate\b/.test(line))); break; } }
  });
  return ok({ path: file, language, symbols, imports, reexports: [], exportedLocalNames: symbols.filter((item) => item.exported).map((item) => item.name), hasSyntaxErrors: false });
}

function patternAdapter(id: string, language: Language, extension: string, patterns: PatternLanguage, tier: LanguageAdapter["tier"] = "basic", capabilities: LanguageAdapter["capabilities"] = BASIC): LanguageAdapter {
  return { id, languages: [language], tier, capabilities, supports: (file) => file.toString().endsWith(extension), parse: (file, content, limits) => parsePatternLanguage(file, content, limits, language, patterns) };
}

export const basicLanguageAdapters: LanguageAdapter[] = [
  patternAdapter("rust-local", "rust", ".rs", {
    imports: [/^\s*use\s+([^;]+);/], declarations: [
      { regex: /\bfn\s+([A-Za-z_]\w*)/, kind: "function" }, { regex: /\bstruct\s+([A-Za-z_]\w*)/, kind: "class" },
      { regex: /\btrait\s+([A-Za-z_]\w*)/, kind: "interface" }, { regex: /\benum\s+([A-Za-z_]\w*)/, kind: "enum" },
    ],
  }),
  patternAdapter("csharp-local", "csharp", ".cs", {
    imports: [/^\s*using\s+([\w.]+)\s*;/], declarations: [
      { regex: /\bclass\s+([A-Za-z_]\w*)/, kind: "class" }, { regex: /\binterface\s+([A-Za-z_]\w*)/, kind: "interface" },
      { regex: /\benum\s+([A-Za-z_]\w*)/, kind: "enum" }, { regex: /\b(?:public|private|protected|internal|static|async|virtual|override|\s)+[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\(/, kind: "method" },
    ],
  }, "full", ["declarations", "imports", "exports", "methods"]),
  patternAdapter("php-local", "php", ".php", {
    imports: [/^\s*use\s+([^;]+);/], declarations: [
      { regex: /\bclass\s+([A-Za-z_]\w*)/, kind: "class" }, { regex: /\binterface\s+([A-Za-z_]\w*)/, kind: "interface" },
      { regex: /\b(?:public|protected|private|static|final|abstract|\s)*function\s+([A-Za-z_]\w*)\s*\(/, kind: "method" },
    ],
  }, "full", ["declarations", "imports", "exports", "methods"]),
  patternAdapter("ruby-local", "ruby", ".rb", {
    imports: [/^\s*require(?:_relative)?\s+["']([^"']+)["']/], declarations: [
      { regex: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" }, { regex: /^\s*module\s+([A-Za-z_]\w*)/, kind: "class" },
      { regex: /^\s*def\s+([A-Za-z_]\w*[!?=]?)/, kind: "method" },
    ],
  }),
  patternAdapter("kotlin-local", "kotlin", ".kt", {
    imports: [/^\s*import\s+([\w.*]+)/], declarations: [
      { regex: /\bclass\s+([A-Za-z_]\w*)/, kind: "class" }, { regex: /\binterface\s+([A-Za-z_]\w*)/, kind: "interface" },
      { regex: /\bobject\s+([A-Za-z_]\w*)/, kind: "class" }, { regex: /\bfun\s+([A-Za-z_]\w*)\s*\(/, kind: "function" },
    ],
  }),
];
