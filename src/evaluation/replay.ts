import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildCodeGraph } from "../analyzer/code-graph.js";
import { attachGovernanceLayers } from "../analyzer/governance.js";
import { loadConfig } from "../config/config.js";
import { analyzePr } from "../github/github.js";
import type { EvaluationDataset, EvaluationCaseRun, EvaluationRun } from "./types.js";

export interface ReplayOptions { limit?: number; onProgress?: (completed: number, total: number) => void }

export function replayDataset(root: string, dataset: EvaluationDataset, options: ReplayOptions = {}): EvaluationRun {
  const startedAt = new Date().toISOString();
  const selected = dataset.cases.slice(0, options.limit ?? dataset.cases.length);
  const cases: EvaluationCaseRun[] = [];
  for (const item of selected) {
    const started = performance.now();
    let worktree: string | undefined;
    try {
      verifyCommit(root, item.baseSha);
      verifyCommit(root, item.headSha);
      const container = fs.mkdtempSync(path.join(os.tmpdir(), "nodenet-eval-"));
      worktree = path.join(container, "repo");
      execFileSync("git", ["-C", root, "worktree", "add", "--detach", worktree, item.headSha], { stdio: "ignore", timeout: 30_000 });
      const config = loadConfig(worktree);
      if (!config.ok) throw config.error;
      const built = buildCodeGraph(worktree, config.value, { incrementalCache: false });
      if (!built.ok) throw built.error;
      const governance = attachGovernanceLayers(built.value.graph, worktree, config.value);
      if (!governance.ok) throw governance.error;
      const analyzed = analyzePr(worktree, config.value, built.value.graph, built.value.index, governance.value.ownership, governance.value.contexts, { base: item.baseSha, mode: "observe" });
      if (!analyzed.ok) throw analyzed.error;
      cases.push({ pullRequest: item.number, decision: analyzed.value.decision, durationMs: Math.round(performance.now() - started), runAt: new Date().toISOString() });
    } catch (cause) {
      cases.push({ pullRequest: item.number, durationMs: Math.round(performance.now() - started), error: cause instanceof Error ? cause.message : String(cause), runAt: new Date().toISOString() });
    } finally {
      if (worktree) {
        try { execFileSync("git", ["-C", root, "worktree", "remove", "--force", worktree], { stdio: "ignore", timeout: 30_000 }); } catch { /* temporary worktree cleanup is best effort */ }
        try { fs.rmSync(path.dirname(worktree), { recursive: true, force: true }); } catch { /* temporary directory cleanup is best effort */ }
      }
    }
    options.onProgress?.(cases.length, selected.length);
  }
  const completedAt = new Date().toISOString();
  return { schemaVersion: "1", id: `run-${completedAt.replace(/[:.]/g, "-")}`, datasetId: dataset.id, startedAt, completedAt, cases };
}

function verifyCommit(root: string, sha: string): void {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error(`Invalid commit SHA: ${sha}`);
  execFileSync("git", ["-C", root, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore", timeout: 10_000 });
}
