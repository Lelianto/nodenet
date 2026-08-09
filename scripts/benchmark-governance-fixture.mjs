#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodenet-governance-benchmark-"));
const fixtureRoot = path.join(repositoryRoot, "test", "fixtures", "cross-team");
try {
  fs.cpSync(fixtureRoot, temporaryRoot, { recursive: true });
  for (const generated of ["graph.json", "index.json", "metadata.json", "symbols.json", "parse-cache.json"]) {
    fs.rmSync(path.join(temporaryRoot, ".nodenet", generated), { force: true });
  }
  run("git", ["init", "-b", "main"], temporaryRoot);
  run("git", ["config", "user.email", "benchmark@nodenet.local"], temporaryRoot);
  run("git", ["config", "user.name", "NodeNet Benchmark"], temporaryRoot);
  run("git", ["add", "."], temporaryRoot);
  run("git", ["commit", "-m", "baseline"], temporaryRoot);
  run("git", ["switch", "-c", "benchmark-change"], temporaryRoot);
  const changedFile = path.join(temporaryRoot, "src", "payment", "PaymentService.ts");
  fs.writeFileSync(changedFile, fs.readFileSync(changedFile, "utf8").replace('return "stl-" + input.cartId;', 'return "settlement-" + input.cartId;'));
  run("git", ["add", "src/payment/PaymentService.ts"], temporaryRoot);
  run("git", ["commit", "-m", "change payment settlement behavior"], temporaryRoot);
  const cli = path.join(repositoryRoot, "dist", "cli", "cli.js");
  run(process.execPath, [cli, "build"], temporaryRoot);
  const result = run(process.execPath, [cli, "benchmark-governance", "--dataset", path.join(repositoryRoot, "examples", "governance-benchmark.template.json"), "--json"], temporaryRoot);
  process.stdout.write(result.stdout);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result;
}
