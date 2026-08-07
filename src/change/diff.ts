/**
 * Change detection (NodeNet spec §12, §13, §42).
 *
 * Git is invoked with argument arrays only — untrusted values are never
 * concatenated into shell strings. Diffs are parsed into hunks, and hunks
 * are mapped to symbols (not just files) to keep reviewer noise down
 * (spec §13: symbol-level change detection).
 */

import { spawnSync } from "node:child_process";
import type { Result } from "../types/result.js";
import { ok, err, GitError } from "../types/result.js";
import { safeRelativePath, type SafeRelativePath } from "../security/filesystem.js";

export interface ChangedHunk {
  relPath: SafeRelativePath;
  /** 1-based line numbers that are additions in the new file. */
  addedLines: number[];
  /** Number of removed lines (new-file line mapping unknown). */
  removedLineCount: number;
  isNewFile: boolean;
  isDeletedFile: boolean;
}

/** Reject refs that could be shell-metacharacter injection (spec §42). */
export function isValidRef(ref: string): boolean {
  if (ref.includes("..")) return false; // git rev ranges are not single refs
  return /^[A-Za-z0-9][A-Za-z0-9._\-\/]*$/.test(ref);
}

/**
 * Read the current change set from git.
 * - base provided: `git diff <base> HEAD` (changes introduced on top of base)
 * - no base: working-tree changes `git diff` (+ untracked files)
 */
export function gitDiffChanges(root: string, base?: string): Result<ChangedHunk[], Error> {
  const probe = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (probe.status !== 0) {
    return err(new GitError("Not inside a git repository. Run `nodenet init` first."));
  }

  const args = ["-C", root, "diff", "--unified=0"];
  if (base !== undefined) {
    if (!isValidRef(base)) {
      return err(new GitError(`Invalid base ref: ${base}`));
    }
    args.push(base, "HEAD");
  }
  args.push("--", ".");
  const diffResult = spawnSync("git", args, { encoding: "utf8", timeout: 15_000 });
  if (diffResult.status !== 0) {
    return err(new GitError(`git diff failed: ${diffResult.stderr ?? ""}`));
  }

  let untracked = "";
  if (base === undefined) {
    const untrackedResult = spawnSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    untracked = untrackedResult.stdout ?? "";
  }

  return ok(parseUnifiedDiff(diffResult.stdout ?? "", untracked));
}

/**
 * Parse `git diff --unified=0` output. `untracked` is a newline-separated
 * list of untracked files (all lines considered added).
 */
export function parseUnifiedDiff(diffText: string, untracked = ""): ChangedHunk[] {
  const hunks: ChangedHunk[] = [];
  const byPath = new Map<string, ChangedHunk>();

  const getHunk = (rel: string): ChangedHunk | undefined => {
    return byPath.get(rel);
  };

  let currentFile: string | null = null;
  let currentHunk: ChangedHunk | undefined;

  const lines = diffText.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = /diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const rel = match?.[1]?.replace(/^"(.*)"$/, "$1") ?? null;
      currentFile = rel;
      if (rel !== null && !byPath.has(rel)) {
        const safe = safeRelativePath(rel);
        if (safe.ok) {
          byPath.set(rel, {
            relPath: safe.value,
            addedLines: [],
            removedLineCount: 0,
            isNewFile: false,
            isDeletedFile: false,
          });
        }
      }
      currentHunk = currentFile ? getHunk(currentFile) : undefined;
      continue;
    }
    if (line.startsWith("new file mode")) {
      const h = currentHunk;
      if (h) h.isNewFile = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      const h = currentHunk;
      if (h) h.isDeletedFile = true;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      const h = currentHunk;
      if (h && match) {
        const startNew = Number(match[3]);
        const countNew = match[4] === undefined ? 1 : Number(match[4]);
        if (!h.isDeletedFile) {
          for (let i = 0; i < countNew; i++) {
            h.addedLines.push(startNew + i);
          }
        }
      }
      continue;
    }
    // Count removed lines inside hunks (for statistics)
    if (line.startsWith("-") && !line.startsWith("---")) {
      const h = currentHunk;
      if (h) h.removedLineCount++;
    }
  }

  // Untracked files: every line added.
  for (const rel of untracked.split("\n")) {
    const trimmed = rel.trim();
    if (!trimmed) continue;
    const safe = safeRelativePath(trimmed);
    if (!safe.ok) continue;
    const existing = byPath.get(trimmed);
    if (existing) {
      existing.isNewFile = true;
      existing.addedLines = [];
      continue;
    }
    byPath.set(trimmed, {
      relPath: safe.value,
      addedLines: [],
      removedLineCount: 0,
      isNewFile: true,
      isDeletedFile: false,
    });
  }

  // NodeNet's own artifacts are never part of the change set.
  for (const [rel, hunk] of [...byPath.entries()]) {
    if (rel.startsWith(".nodenet/")) byPath.delete(rel);
    void hunk;
  }

  for (const hunk of byPath.values()) hunks.push(hunk);
  hunks.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return hunks;
}
