/**
 * Deterministic AST analysis (NodeNet spec §49, §50).
 *
 * Parser choice: TypeScript Compiler API. See docs/adr/001-parser.md for
 * the comparison against tree-sitter/SWC/ts-morph. We parse each file
 * independently (no type checker) so analysis stays fast, deterministic and
 * incremental; cross-file symbol resolution happens in the analyzer via an
 * explicit import/export table.
 *
 * Every parse is bounded by resource limits and never executes repository
 * code (spec §21).
 */

import ts from "typescript";
import type { SafeRelativePath } from "../security/filesystem.js";
import type { Result } from "../types/result.js";
import { ok, err, errorMessage } from "../types/result.js";
import type { Limits } from "../security/limits.js";

export type Language = "typescript" | "tsx" | "javascript" | "jsx" | "python" | "go" | "java" | "rust" | "csharp" | "php" | "ruby" | "kotlin";

export type ParsedSymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "typeAlias"
  | "enum"
  | "variable"
  | "reactComponent"
  | "reactHook";

export interface ParsedSymbol {
  kind: ParsedSymbolKind;
  /** Full display name, e.g. `createSettlement` or `PaymentService.amount`. */
  name: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  isDefault: boolean;
  /** Identifier names referenced inside the body (potential calls/uses). */
  references: string[];
  /** JSX element names used inside a component body. */
  jsxRefs: string[];
  /** Names in heritage clauses (extends/implements). */
  heritage: { name: string; relation: "extends" | "implements" }[];
}

export interface ImportBinding {
  /** Local name used in code. */
  local: string;
  /** Exported name on the target module (defaults to `local`). */
  imported?: string;
}

export interface ParsedImport {
  specifier: string;
  bindings: ImportBinding[];
  namespace?: string;
  defaultName?: string;
}

export interface ParsedReexport {
  specifier?: string;
  names: string[];
  wildcard: boolean;
}

export interface ParsedFile {
  path: SafeRelativePath;
  language: Language;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  reexports: ParsedReexport[];
  /** Local symbol names re-exported (`export { a }`). */
  exportedLocalNames: string[];
  hasSyntaxErrors: boolean;
}

export function languageForPath(p: SafeRelativePath): Language {
  const lower = p.toString().toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".js")) return "javascript";
  if (lower.endsWith(".mts") || lower.endsWith(".cts")) return "typescript";
  if (lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  return "typescript";
}

export function isSupportedSource(p: SafeRelativePath): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(p.toString());
}

export function isTestFile(p: SafeRelativePath): boolean {
  const lower = p.toString().toLowerCase();
  return /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(lower) || /(^|\/)test_.*\.py$/.test(lower) || /_test\.go$/.test(lower) || /(?:test|tests)\.java$/.test(lower) || /_test\.rs$/.test(lower) || /(?:tests?|specs?)\.cs$/.test(lower) || /(?:test|spec)\.php$/.test(lower) || /_spec\.rb$/.test(lower) || /(?:test|spec)\.kt$/.test(lower) || lower.includes("/__tests__/");
}

export function isConfigFile(p: SafeRelativePath): boolean {
  const name = p.toString().toLowerCase();
  return (
    name.endsWith(".config.json") ||
    name === "tsconfig.json" ||
    name.endsWith("tsconfig.json") ||
    name.endsWith(".config.ts") ||
    name.endsWith(".config.js") ||
    name === "package.json" ||
    name === "nodenet.config.json"
  );
}

/** Parse a single source file into symbols. Never throws. */
export function parseSourceFile(
  path: SafeRelativePath,
  content: string,
  limits: Limits,
): Result<ParsedFile, Error> {
  try {
    const scriptKind: ts.ScriptKind = path.toString().endsWith("tsx")
      ? ts.ScriptKind.TSX
      : path.toString().endsWith("jsx")
        ? ts.ScriptKind.JSX
        : path.toString().endsWith("ts") || path.toString().endsWith("mts") || path.toString().endsWith("cts")
          ? ts.ScriptKind.TS
          : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(path.toString(), content, ts.ScriptTarget.Latest, true, scriptKind);

    const hasSyntaxErrors = (sf as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0;
    const parsed: ParsedFile = {
      path,
      language: languageForPath(path),
      symbols: [],
      imports: [],
      reexports: [],
      exportedLocalNames: [],
      hasSyntaxErrors,
    };

    let nodeCount = 0;
    const budgetReached = { value: false };
    const countNode = (n: ts.Node): void => {
      nodeCount++;
      if (nodeCount > limits.maxAstNodesPerFile) budgetReached.value = true;
      if (budgetReached.value) return;
      void n;
    };

    const topLevel: ts.Statement[] = [];
    for (const stmt of sf.statements) {
      topLevel.push(stmt);
    }

    // Handle `export default foo;` and `export = foo` (Identifier assignments).
    const defaultExportNames = new Set<string>();
    for (const stmt of topLevel) {
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && ts.isIdentifier(stmt.expression)) {
        defaultExportNames.add(stmt.expression.text);
      }
    }

    const exportedLocalNames = new Set<string>();
    for (const stmt of topLevel) {
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier === undefined && stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          exportedLocalNames.add(spec.propertyName ? spec.propertyName.text : spec.name.text);
        }
      }
      if (ts.isImportDeclaration(stmt)) {
        const mod = stmt.moduleSpecifier;
        if (!ts.isStringLiteral(mod)) continue;
        const parsedImport = parseImport(stmt, mod.text);
        if (parsedImport) parsed.imports.push(parsedImport);
      }
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const names: string[] = [];
        let wildcard = false;
        if (stmt.exportClause === undefined) {
          wildcard = true;
        } else if (ts.isNamedExports(stmt.exportClause)) {
          for (const spec of stmt.exportClause.elements) {
            names.push(spec.propertyName ? `${spec.propertyName.text} as ${spec.name.text}` : spec.name.text);
          }
        } else {
          wildcard = true;
        }
        parsed.reexports.push({ specifier: stmt.moduleSpecifier.text, names, wildcard });
      }
    }

    for (const stmt of topLevel) {
      const symbols = parseStatement(sf, stmt, path, defaultExportNames, countNode, budgetReached);
      parsed.symbols.push(...symbols);
      if (budgetReached.value) break;
    }

    parsed.exportedLocalNames = [...exportedLocalNames];
    return ok(parsed);
  } catch (e) {
    return err(new Error(`Parse failed for ${path.toString()}: ${errorMessage(e)}`));
  }
}

function parseImport(stmt: ts.ImportDeclaration, specifier: string): ParsedImport | undefined {
  const clause = stmt.importClause;
  if (!clause) return undefined;
  const result: ParsedImport = { specifier, bindings: [] };
  if (clause.name) result.defaultName = clause.name.text;
  const named = clause.namedBindings;
  if (named) {
    if (ts.isNamespaceImport(named)) {
      result.namespace = named.name.text;
    } else if (ts.isNamedImports(named)) {
      for (const el of named.elements) {
        result.bindings.push({
          local: el.name.text,
          ...(el.propertyName !== undefined ? { imported: el.propertyName.text } : {}),
        });
      }
    }
  }
  return result;
}

function isExported(stmt: ts.Statement): boolean {
  return (ts.getCombinedModifierFlags(stmt as unknown as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function hasJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function isCallableInitializer(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Collect referenced identifiers (skipping nested declarations and own name). */
function collectReferences(
  node: ts.Node,
  selfName: string,
  nestedNames: Set<string>,
  countNode: (n: ts.Node) => void,
): { refs: string[]; jsx: string[] } {
  const refs = new Set<string>();
  const jsx = new Set<string>();

  const visit = (n: ts.Node): void => {
    countNode(n);
    // Skip nested scope declarations (their bodies belong to the nested
    // symbol). Variable statements are walked so calls like
    // `const { count } = useCounter(0)` inside a body are still seen.
    if (
      n !== node &&
      (ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isInterfaceDeclaration(n) ||
        ts.isTypeAliasDeclaration(n) ||
        ts.isEnumDeclaration(n) ||
        ts.isMethodDeclaration(n))
    ) {
      return;
    }
    if (ts.isIdentifier(n)) {
      const text = n.text;
      const parent = n.parent;
      const isDeclName =
        parent &&
        (ts.isFunctionDeclaration(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isInterfaceDeclaration(parent) ||
          ts.isTypeAliasDeclaration(parent) ||
          ts.isEnumDeclaration(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isParameter(parent) ||
          ts.isBindingElement(parent)) &&
        (parent as { name?: ts.Node }).name === n;
      const isPropAccess = ts.isPropertyAccessExpression(parent) && parent.name === n;
      const isImportSpec = ts.isImportSpecifier(parent) && parent.name === n;
      const isExportSpec = ts.isExportSpecifier(parent) && parent.name === n;
      const isQualifiedName = ts.isQualifiedName(parent) && parent.right === n;
      if (!isDeclName && !isPropAccess && !isImportSpec && !isExportSpec && !isQualifiedName && text !== selfName && !nestedNames.has(text)) {
        refs.add(text);
      }
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName;
      if (ts.isIdentifier(tag)) jsx.add(tag.text);
    }
    ts.forEachChild(n, visit);
  };

  visit(node);
  return { refs: [...refs], jsx: [...jsx] };
}

function collectNestedNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) {
      if (n.name) names.add(n.name.text);
    } else if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name)) names.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return names;
}

function parseStatement(
  sf: ts.SourceFile,
  stmt: ts.Statement,
  filePath: SafeRelativePath,
  defaultExportNames: Set<string>,
  countNode: (n: ts.Node) => void,
  budget: { value: boolean },
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  if (ts.isFunctionDeclaration(stmt)) {
    const name = stmt.name ? stmt.name.text : "(anonymous)";
    const containsJsx = hasJsx(stmt);
    const kind: ParsedSymbolKind = /^[A-Z]/.test(name) && containsJsx
      ? "reactComponent"
      : name.startsWith("use")
        ? "reactHook"
        : "function";
    const refs = collectReferences(stmt, name, collectNestedNames(stmt), countNode);
    const isDefault = defaultExportNames.has(name) || isDefaultFunction(stmt);
    symbols.push({
      kind,
      name,
      startLine: lineOf(sf, stmt.getStart(sf)),
      endLine: lineOf(sf, stmt.getEnd()),
      exported: isExported(stmt) || defaultExportNames.has(name) || isDefault,
      isDefault,
      references: refs.refs,
      jsxRefs: kind === "reactComponent" ? refs.jsx : [],
      heritage: [],
    });
    return symbols;
  }

  if (ts.isClassDeclaration(stmt)) {
    const className = stmt.name ? stmt.name.text : "(anonymous)";
    const heritage: { name: string; relation: "extends" | "implements" }[] = [];
    if (stmt.heritageClauses) {
      for (const clause of stmt.heritageClauses) {
        const relation: "extends" | "implements" =
          clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
        for (const type of clause.types) {
          if (ts.isExpressionWithTypeArguments(type) && ts.isIdentifier(type.expression)) {
            heritage.push({ name: type.expression.text, relation });
          }
        }
      }
    }
    const refs = collectReferences(stmt, className, collectNestedNames(stmt), countNode);
    const isDefault = defaultExportNames.has(className);
    symbols.push({
      kind: "class",
      name: className,
      startLine: lineOf(sf, stmt.getStart(sf)),
      endLine: lineOf(sf, stmt.getEnd()),
      exported: isExported(stmt) || isDefault,
      isDefault,
      references: refs.refs,
      jsxRefs: [],
      heritage,
    });
    // Methods
    if (stmt.members) {
      for (const member of stmt.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        if (!member.name || !ts.isIdentifier(member.name)) continue;
        const methodName = member.name.text;
        if (methodName === "constructor") continue;
        const mrefs = collectReferences(member, methodName, new Set(), countNode);
        symbols.push({
          kind: "method",
          name: `${className}.${methodName}`,
          startLine: lineOf(sf, member.getStart(sf)),
          endLine: lineOf(sf, member.getEnd()),
          exported: false,
          isDefault: false,
          references: mrefs.refs,
          jsxRefs: mrefs.jsx,
          heritage: [],
        });
      }
    }
    return symbols;
  }

  if (ts.isInterfaceDeclaration(stmt)) {
    const name = stmt.name.text;
    symbols.push({
      kind: "interface",
      name,
      startLine: lineOf(sf, stmt.getStart(sf)),
      endLine: lineOf(sf, stmt.getEnd()),
      exported: isExported(stmt),
      isDefault: false,
      references: [],
      jsxRefs: [],
      heritage: stmt.heritageClauses
        ? stmt.heritageClauses.flatMap((c) =>
            c.types
              .filter((t) => ts.isExpressionWithTypeArguments(t) && ts.isIdentifier(t.expression))
              .map((t) => ({
                name: (t.expression as ts.Identifier).text,
                relation: c.token === ts.SyntaxKind.ExtendsKeyword ? ("extends" as const) : ("implements" as const),
              })),
          )
        : [],
    });
    return symbols;
  }

  if (ts.isTypeAliasDeclaration(stmt)) {
    symbols.push({
      kind: "typeAlias",
      name: stmt.name.text,
      startLine: lineOf(sf, stmt.getStart(sf)),
      endLine: lineOf(sf, stmt.getEnd()),
      exported: isExported(stmt),
      isDefault: false,
      references: [],
      jsxRefs: [],
      heritage: [],
    });
    return symbols;
  }

  if (ts.isEnumDeclaration(stmt)) {
    symbols.push({
      kind: "enum",
      name: stmt.name.text,
      startLine: lineOf(sf, stmt.getStart(sf)),
      endLine: lineOf(sf, stmt.getEnd()),
      exported: isExported(stmt),
      isDefault: false,
      references: [],
      jsxRefs: [],
      heritage: [],
    });
    return symbols;
  }

  if (ts.isVariableStatement(stmt)) {
    const exported = isExported(stmt);
    const out: ParsedSymbol[] = [];
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      const isDefault = defaultExportNames.has(name);
      const initializer = decl.initializer;
      const isCallable = initializer !== undefined && isCallableInitializer(initializer);
      const containsJsx = initializer !== undefined && hasJsx(initializer);
      const isComponent = /^[A-Z]/.test(name) && containsJsx;
      const isHook = name.startsWith("use") && isCallable;
      const kind: ParsedSymbolKind = isComponent
        ? "reactComponent"
        : isHook
          ? "reactHook"
          : isCallable
            ? "function"
            : "variable";
      const refs = collectReferences(decl, name, collectNestedNames(decl), countNode);
      out.push({
        kind,
        name,
        startLine: lineOf(sf, decl.getStart(sf)),
        endLine: lineOf(sf, decl.getEnd()),
        exported: exported || isDefault,
        isDefault,
        references: refs.refs,
        jsxRefs: kind === "reactComponent" ? refs.jsx : [],
        heritage: [],
      });
    }
    return out;
  }

  if (ts.isModuleDeclaration(stmt)) {
    const body = stmt.body;
    if (body && ts.isModuleBlock(body)) {
      for (const inner of body.statements) {
        symbols.push(...parseStatement(sf, inner, filePath, defaultExportNames, countNode, budget));
      }
    }
    return symbols;
  }

  return symbols;
}

function isDefaultFunction(stmt: ts.FunctionDeclaration): boolean {
  // `export default function foo() {}` — default modifier
  return (ts.getCombinedModifierFlags(stmt) & ts.ModifierFlags.Default) !== 0;
}
