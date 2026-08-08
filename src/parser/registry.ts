/** Extensible parser boundary. Language adapters remain deterministic and local. */
import type { Limits } from "../security/limits.js";
import type { SafeRelativePath } from "../security/filesystem.js";
import type { Result } from "../types/result.js";
import { isSupportedSource as supportsTypeScriptFamily, parseSourceFile, type ParsedFile } from "./typescript.js";
import { basicLanguageAdapters, goAdapter, javaAdapter, pythonAdapter } from "./polyglot.js";
import type { Language } from "./typescript.js";

export type LanguageSupportTier = "full" | "basic";
export type LanguageCapability = "declarations" | "imports" | "exports" | "methods" | "inheritance" | "references";

export interface LanguageAdapter {
  readonly id: string;
  readonly languages: readonly Language[];
  readonly tier: LanguageSupportTier;
  readonly capabilities: readonly LanguageCapability[];
  supports(path: SafeRelativePath): boolean;
  parse(path: SafeRelativePath, content: string, limits: Limits): Result<ParsedFile, Error>;
}

const adapters: LanguageAdapter[] = [{
  id: "typescript-compiler",
  languages: ["typescript", "javascript"],
  tier: "full",
  capabilities: ["declarations", "imports", "exports", "methods", "inheritance", "references"],
  supports: supportsTypeScriptFamily,
  parse: parseSourceFile,
}, pythonAdapter, goAdapter, javaAdapter, ...basicLanguageAdapters];

export function registerLanguageAdapter(adapter: LanguageAdapter): void {
  const existing = adapters.findIndex((candidate) => candidate.id === adapter.id);
  if (existing >= 0) adapters[existing] = adapter;
  else adapters.push(adapter);
}

export function languageAdapterFor(path: SafeRelativePath): LanguageAdapter | undefined {
  return adapters.find((adapter) => adapter.supports(path));
}

export function supportedByLanguageAdapter(path: SafeRelativePath): boolean {
  return languageAdapterFor(path) !== undefined;
}

export function parseWithLanguageAdapter(path: SafeRelativePath, content: string, limits: Limits): Result<ParsedFile, Error> {
  const adapter = languageAdapterFor(path);
  if (!adapter) throw new Error(`No language adapter for ${path.toString()}`);
  return adapter.parse(path, content, limits);
}

export function registeredLanguageAdapters(): readonly LanguageAdapter[] { return adapters; }

export function languageSupportMatrix(): Array<{ language: Language; tier: LanguageSupportTier; adapter: string; capabilities: readonly LanguageCapability[] }> {
  return adapters.flatMap((adapter) => adapter.languages.map((language) => ({ language, tier: adapter.tier, adapter: adapter.id, capabilities: adapter.capabilities })));
}
