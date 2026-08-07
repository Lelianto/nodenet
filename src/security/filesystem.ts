/**
 * Safe filesystem abstraction (NodeNet spec §39).
 *
 * `SafeRelativePath` is a validated relative path that can never escape the
 * repository root. All reads performed by NodeNet go through
 * `resolveSafe`, which re-checks containment after realpath resolution so
 * symlinks cannot smuggle reads outside the repository.
 */

import path from "node:path";
import fs from "node:fs";
import type { Brand } from "../types/brand.js";
import type { Result } from "../types/result.js";
import { ok, err, UnsafePathError } from "../types/result.js";

export type SafeRelativePath = Brand<string, "SafeRelativePath">;

const SEP = "/";

/**
 * Validate and normalize a repository-relative path.
 * Rejects: absolute paths, drive letters, `..` segments, NUL bytes,
 * backslashes (treated as unsafe), and empty paths.
 */
export function safeRelativePath(input: string): Result<SafeRelativePath, UnsafePathError> {
  if (input.length === 0) return err(new UnsafePathError("Path must not be empty."));
  if (input.includes("\u0000")) return err(new UnsafePathError("Path contains NUL byte."));
  if (input.includes("\\")) return err(new UnsafePathError(`Path contains a backslash: ${input}`));
  if (path.isAbsolute(input)) return err(new UnsafePathError(`Absolute paths are not allowed: ${input}`));
  if (/^[A-Za-z]:/.test(input)) return err(new UnsafePathError(`Drive-letter paths are not allowed: ${input}`));

  const segments = input.split(SEP);
  for (const segment of segments) {
    if (segment === "..") return err(new UnsafePathError(`Path escapes the repository: ${input}`));
    if (segment === ".") return err(new UnsafePathError(`Path contains redundant '.': ${input}`));
  }
  const normalized = segments.filter((s) => s.length > 0).join(SEP);
  return ok(normalized as SafeRelativePath);
}

/** Join two safe relative paths (dir + file). */
export function joinSafe(dir: SafeRelativePath, file: SafeRelativePath): Result<SafeRelativePath, UnsafePathError> {
  return safeRelativePath(`${dir.toString()}/${file.toString()}`);
}

/** Directory portion of a safe path ('' for a top-level path). */
export function dirnameSafe(p: SafeRelativePath): SafeRelativePath {
  const idx = p.toString().lastIndexOf(SEP);
  return (idx < 0 ? "" : p.toString().slice(0, idx)) as SafeRelativePath;
}

/** Basename of a safe path. */
export function basenameSafe(p: SafeRelativePath): string {
  const idx = p.toString().lastIndexOf(SEP);
  return idx < 0 ? p.toString() : p.toString().slice(idx + 1);
}

/**
 * Resolve a safe relative path against the repository root and verify the
 * result (after realpath) is still inside the root. This is the ONLY way
 * NodeNet reads repository files.
 */
export function resolveSafe(root: string, rel: SafeRelativePath): Result<string, UnsafePathError> {
  const resolved = path.resolve(root, rel.toString());
  if (!isWithin(root, resolved)) {
    return err(new UnsafePathError(`Resolved path escapes the repository root: ${rel.toString()}`));
  }
  // Symlink defense: re-check against the real (canonical) paths.
  try {
    const realResolved = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(root);
    if (!isWithin(realRoot, realResolved)) {
      return err(new UnsafePathError(`Symlink escapes the repository root: ${rel.toString()}`));
    }
  } catch (e) {
    // File may not exist yet (e.g. analysis-only); the lexical check stands.
    void e;
  }
  return ok(resolved);
}

function isWithin(root: string, candidate: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  if (c === r) return true;
  return c.startsWith(r + path.sep);
}

/** Convenience: read a file's contents via the safe resolver. */
export function readFileSafe(root: string, rel: SafeRelativePath): Result<string, Error> {
  const resolved = resolveSafe(root, rel);
  if (!resolved.ok) return resolved;
  try {
    return ok(fs.readFileSync(resolved.value, "utf8"));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
