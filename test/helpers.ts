import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { buildCodeGraph } from "../src/analyzer/code-graph.js";
import { attachGovernanceLayers } from "../src/analyzer/governance.js";
import { loadConfig, type LoadedConfig } from "../src/config/config.js";
import type { AnalysisState } from "../src/types/analysis-state.js";

export function fixtureRoot(name: string): string {
  return path.join(process.cwd(), "test", "fixtures", name);
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nodenet-test-"));
}

export function copyFixture(name: string, dest: string): void {
  fs.cpSync(fixtureRoot(name), dest, { recursive: true });
}

/**
 * Create a git repository from a fixture. When `modify` is given, a
 * `feature` branch is created, the callback mutates the working tree, and
 * the change is committed — simulating a PR head on top of `main`.
 */
export function makeGitRepo(fixture: string, modify?: (dir: string) => void): string {
  const dir = tmpDir();
  copyFixture(fixture, dir);
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  execSync("git branch -M main", { cwd: dir });
  execSync("git add .", { cwd: dir });
  execSync("git commit -q -m init", { cwd: dir });
  if (modify) {
    execSync("git checkout -q -b feature", { cwd: dir });
    modify(dir);
    execSync("git add .", { cwd: dir });
    execSync("git commit -q -m feature", { cwd: dir });
  }
  return dir;
}

/** Build a full analysis state (graph + governance layers) from a root. */
export function buildFixtureState(root: string): { root: string; config: LoadedConfig } & AnalysisState {
  const config = loadConfig(root);
  if (!config.ok) throw config.error;
  const build = buildCodeGraph(root, config.value);
  if (!build.ok) throw build.error;
  const governance = attachGovernanceLayers(build.value.graph, root, config.value);
  if (!governance.ok) throw governance.error;
  return {
    root,
    config: config.value,
    graph: build.value.graph,
    index: build.value.index,
    contexts: governance.value.contexts,
    ownership: governance.value.ownership,
    warnings: [...build.value.warnings, ...governance.value.warnings],
  };
}

/** Capture everything written to process.stdout during a callback. */
export function captureStdout<T>(fn: () => T): { result: T; output: string } {
  const chunks: string[] = [];
  const stdout = process.stdout as unknown as { write: (chunk: string | Uint8Array) => boolean };
  const original = stdout.write.bind(stdout);
  stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    return { result: fn(), output: chunks.join("") };
  } finally {
    stdout.write = original;
  }
}
