/**
 * Repository scanner (NodeNet spec §40, §45, §49).
 *
 * Walks the repository iteratively (no recursion depth issues), skipping
 * ignored, secret-like and out-of-root files. Symlinks are only followed
 * when their real path stays inside the repository root. Limits fail
 * safely: oversized/too-many files are skipped with warnings, never crashes.
 */

import fs from "node:fs";
import path from "node:path";
import type { Result } from "../types/result.js";
import { ok, err, UnsafePathError, LimitExceededError, errorMessage } from "../types/result.js";
import { safeRelativePath, type SafeRelativePath } from "../security/filesystem.js";
import { isSecretFilePath } from "../security/secrets.js";
import { matchGlob } from "../utils/glob.js";
import type { LoadedConfig } from "../config/config.js";

export interface ScanEntry {
  relPath: SafeRelativePath;
  absPath: string;
  size: number;
  isSymlink: boolean;
}

export interface ScanResult {
  files: ScanEntry[];
  packageJsonPaths: SafeRelativePath[];
  warnings: string[];
}

const ALWAYS_IGNORED = [".git", "node_modules", ".nodenet"];

export function scanRepository(root: string, config: LoadedConfig): Result<ScanResult, Error> {
  const result: ScanResult = { files: [], packageJsonPaths: [], warnings: [] };
  const seen = new Set<string>();

  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      result.warnings.push(`Cannot read directory ${dir}: ${errorMessage(e)}`);
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      const relPosix = rel.split(path.sep).join("/");

      if (entry.isSymbolicLink()) {
        let real: string;
        try {
          real = fs.realpathSync(abs);
        } catch (e) {
          result.warnings.push(`Broken symlink skipped: ${relPosix} (${errorMessage(e)})`);
          continue;
        }
        const rootReal = fs.realpathSync(root);
        if (!(real === rootReal || real.startsWith(rootReal + path.sep))) {
          result.warnings.push(`Symlink outside repository skipped: ${relPosix}`);
          continue;
        }
      }

      const topSegment = relPosix.split("/")[0] ?? "";
      if (ALWAYS_IGNORED.includes(topSegment)) continue;
      if (matchGlobIn(config.ignore, relPosix)) continue;
      if (isSecretFilePath(relPosix)) continue;

      // For symlinks, stat (which follows the link) decides whether the
      // target is a file or directory; the containment check above already
      // verified it stays inside the repository.
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch (e) {
          result.warnings.push(`Cannot stat symlink ${relPosix}: ${errorMessage(e)}`);
          continue;
        }
      }

      if (isDir) {
        stack.push(abs);
      } else if (isFile) {
        if (result.files.length >= config.limits.maxFiles) {
          result.warnings.push(
            new LimitExceededError(`File limit (${config.limits.maxFiles}) reached; further files skipped.`).message,
          );
          continue;
        }
        const safe = safeRelativePath(relPosix);
        if (!safe.ok) {
          result.warnings.push(`Unsafe path skipped: ${relPosix} (${safe.error.message})`);
          continue;
        }
        if (seen.has(relPosix)) continue;
        seen.add(relPosix);
        let size: number;
        try {
          size = fs.statSync(abs).size;
        } catch (e) {
          result.warnings.push(`Cannot stat ${relPosix}: ${errorMessage(e)}`);
          continue;
        }
        if (size > config.limits.maxFileSizeBytes) {
          result.warnings.push(
            `File exceeds maximum parse size (${size} bytes): ${relPosix}. Skipping with warning.`,
          );
          continue;
        }
        result.files.push({ relPath: safe.value, absPath: abs, size, isSymlink: entry.isSymbolicLink() });
        if (entry.name === "package.json") {
          result.packageJsonPaths.push(safe.value);
        }
      }
      // sockets, fifos, etc. are ignored silently
    }
  }

  result.files.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return ok(result);
}

function matchGlobIn(patterns: string[], relPosix: string): boolean {
  return patterns.some((pat) => matchGlob(pat, relPosix));
}

/** Safe file read through the scanner entry. */
export function readScannedFile(entry: ScanEntry): Result<string, Error> {
  try {
    return ok(fs.readFileSync(entry.absPath, "utf8"));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

export type { UnsafePathError };
