import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runCli } from "../src/cli/cli.js";
import { appendAudit } from "../src/storage/storage.js";
import { copyFixture, tmpDir, captureStdout } from "./helpers.js";

const workDirs: string[] = [];
function work(name: string): string {
  const dir = tmpDir();
  workDirs.push(dir);
  copyFixture(name, path.join(dir, "repo"));
  return path.join(dir, "repo");
}

afterAll(() => {
  for (const dir of workDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("nodenet CLI", () => {
  it("audit-verify reports a valid hash chain", async () => {
    const repo = work("basic-typescript");
    appendAudit(repo, { type: "test", at: "2026-01-01T00:00:00.000Z", outcome: "success" });
    const { output, result } = captureStdout(() => runCli(["audit-verify", "--json"], { cwd: repo }));
    expect(await result).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ valid: true, verifiedRecords: 1 });
  });

  it("init creates config and .nodenet", async () => {
    const dir = tmpDir();
    workDirs.push(dir);
    const { output, result } = captureStdout(() => runCli(["init"], { cwd: dir }));
    expect(await result).toBe(0);
    expect(fs.existsSync(path.join(dir, "nodenet.config.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".nodenet"))).toBe(true);
    expect(output).toContain("Initialized NodeNet");
  });

  it("build persists the unified graph", async () => {
    const repo = work("basic-typescript");
    const code = await runCli(["build"], { cwd: repo });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(repo, ".nodenet", "graph.json"))).toBe(true);
    const metadata = JSON.parse(fs.readFileSync(path.join(repo, ".nodenet", "metadata.json"), "utf8"));
    expect(metadata.nodeCount).toBeGreaterThan(10);
  });

  it("build --json emits machine-readable output", async () => {
    const repo = work("basic-typescript");
    const { output, result } = captureStdout(() => runCli(["build", "--json"], { cwd: repo }));
    expect(await result).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.nodes).toBeGreaterThan(10);
  });

  it("query finds symbols", async () => {
    const repo = work("basic-typescript");
    expect(await runCli(["build"], { cwd: repo })).toBe(0);
    const { output, result } = captureStdout(() => runCli(["query", "add"], { cwd: repo }));
    expect(await result).toBe(0);
    expect(output).toContain("add");
  });

  it("ask, affected, and progressive source context expose retrieval UX", async () => {
    const repo = work("cross-team");
    expect(await runCli(["build"], { cwd: repo })).toBe(0);
    const asked = captureStdout(() => runCli(["ask", "what connects checkout to payment", "--json"], { cwd: repo }));
    expect(await asked.result).toBe(0);
    expect(JSON.parse(asked.output).matches.length).toBeGreaterThan(0);
    const affected = captureStdout(() => runCli(["affected", "PaymentService", "--json"], { cwd: repo }));
    expect(await affected.result).toBe(0);
    expect(JSON.parse(affected.output).affected.length).toBeGreaterThan(0);
    const context = captureStdout(() => runCli(["context", "createSettlement", "--detail", "source", "--json"], { cwd: repo }));
    expect(await context.result).toBe(0);
    expect(JSON.parse(context.output).sourceEvidence.length).toBeGreaterThan(0);
  });

  it("runs the executable ten-language benchmark", async () => {
    const repo = work("basic-typescript");
    const result = captureStdout(() => runCli(["benchmark-languages", "--json"], { cwd: repo }));
    expect(await result.result).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ cases: 20, passed: 20, passRate: 1 });
  });

  it("context lists living contexts", async () => {
    const repo = work("cross-team");
    expect(await runCli(["build"], { cwd: repo })).toBe(0);
    const { output, result } = captureStdout(() => runCli(["context"], { cwd: repo }));
    expect(await result).toBe(0);
    expect(output).toContain("PAYMENT-003");
    expect(output).toContain("SEC-009");
  });

  it("context applies the automatic token budget without user configuration", async () => {
    const repo = work("cross-team");
    expect(await runCli(["build"], { cwd: repo })).toBe(0);
    const { output, result } = captureStdout(() => runCli(["context", "createSettlement", "--json"], { cwd: repo }));
    expect(await result).toBe(0);
    const bundle = JSON.parse(output) as { metrics: { budgetTokens: number; estimatedTokens: number } };
    expect(bundle.metrics.budgetTokens).toBe(2000);
    expect(bundle.metrics.estimatedTokens).toBeGreaterThan(0);
  });

  it("context migrates legacy records to the LCDD 0.6 Registry", async () => {
    const repo = work("cross-team");
    const preview = await runCli(["context", "--migrate", "--json"], { cwd: repo });
    expect(preview).toBe(0);
    expect(fs.existsSync(path.join(repo, ".lcdd", "contexts", "PAYMENT-003.yaml"))).toBe(false);

    const written = await runCli(["context", "--migrate", "--write", "--json"], { cwd: repo });
    expect(written).toBe(0);
    expect(fs.existsSync(path.join(repo, ".lcdd", "contexts", "PAYMENT-003.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".lcdd", "contexts", "SEC-009.yaml"))).toBe(true);
  });

  it("health reports metrics derived from graph state", async () => {
    const repo = work("cross-team");
    expect(await runCli(["build"], { cwd: repo })).toBe(0);
    const { output, result } = captureStdout(() => runCli(["health"], { cwd: repo }));
    expect(await result).toBe(0);
    expect(output).toContain("Context artifacts: 2");
    expect(output).toContain("Ownership coverage:");
  });

  it("impact works against a real git diff", async () => {
    const repo = work("cross-team");
    expect(await runCli(["build"], { cwd: repo })).toBe(0);
    // make it a git repo with an initial commit
    const git = (args: string[]): void => {
      const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      expect(result.status).toBe(0, result.stderr ?? "");
    };
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@nodenet.dev"]);
    git(["config", "user.name", "NodeNet Test"]);
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);

    // modify a line inside checkout()
    const file = path.join(repo, "src", "checkout", "CheckoutService.ts");
    const content = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, content.replace("const input: SettlementInput = { cartId, amount: 0 };", "const input: SettlementInput = { cartId, amount: 1 };"));

    const { output, result } = captureStdout(() => runCli(["impact", "--json"], { cwd: repo }));
    expect(await result).toBe(0);
    const report = JSON.parse(output);
    expect(report.severity).toBe("HIGH");
    expect(report.changedFiles).toContain("src/checkout/CheckoutService.ts");
    expect(report.crossTeamBoundary).toBe(true);
  });

  it("reviewers resolves required and authority reviewers for the current change", async () => {
    const repo = work("cross-team");
    expect(await runCli(["build"], { cwd: repo })).toBe(0);
    const git = (args: string[]): void => {
      const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      expect(result.status).toBe(0, result.stderr ?? "");
    };
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@nodenet.dev"]);
    git(["config", "user.name", "NodeNet Test"]);
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);
    const file = path.join(repo, "src", "checkout", "CheckoutService.ts");
    const content = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, content.replace("const input: SettlementInput = { cartId, amount: 0 };", "const input: SettlementInput = { cartId, amount: 2 };"));

    const { output, result } = captureStdout(() => runCli(["reviewers", "--json"], { cwd: repo }));
    expect(await result).toBe(0);
    const review = JSON.parse(output);
    expect(review.required.map((r: { target: string }) => r.target)).toContain("payment-team");
    expect(review.authorityRequired.map((r: { target: string }) => r.target)).toContain("finance-team");
  });

  it("github pr exits with code 2 for a blocking decision in enforce mode", async () => {
    const repo = work("cross-team");
    const git = (args: string[]): void => {
      const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      expect(result.status).toBe(0, result.stderr ?? "");
    };
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@nodenet.dev"]);
    git(["config", "user.name", "NodeNet Test"]);
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);
    git(["switch", "-c", "feature"]);

    const file = path.join(repo, "src", "payment", "PaymentService.ts");
    fs.appendFileSync(file, "\nexport const governanceProbe = true;\n");
    git(["add", "-A"]);
    git(["commit", "-m", "change hardened payment code"]);

    expect(await runCli(["build", "--json"], { cwd: repo })).toBe(0);
    const result = await runCli([
      "github", "pr",
      "--repo", "acme/cart",
      "--pr", "42",
      "--base", "main",
      "--mode", "enforce",
      "--json",
    ], { cwd: repo });
    expect(result).toBe(2);
  });

  it("graph generates static HTML", async () => {
    const repo = work("basic-typescript");
    expect(await runCli(["build"], { cwd: repo })).toBe(0);
    const out = path.join(repo, "graph.html");
    const result = await runCli(["graph", "-o", out], { cwd: repo });
    expect(result).toBe(0);
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('<canvas id="g"');
    expect(html).toContain('var DATA =');
  });

  it("report emits a markdown highlights report", async () => {
    const repo = work("cross-team");
    expect(await runCli(["build"], { cwd: repo })).toBe(0);
    const { output, result } = captureStdout(() => runCli(["report"], { cwd: repo }));
    expect(await result).toBe(0);
    expect(output).toContain("# NodeNet Report");
    expect(output).toContain("## God nodes");
    expect(output).toContain("## Governance");
    expect(output).toContain("**Contexts:** 2");
  });

  it("report --json emits machine-readable output", async () => {
    const repo = work("cross-team");
    expect(await runCli(["build"], { cwd: repo })).toBe(0);
    const { output, result } = captureStdout(() => runCli(["report", "--json"], { cwd: repo }));
    expect(await result).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.godNodes.length).toBeGreaterThan(0);
    expect(parsed.summary.files).toBeGreaterThan(0);
  });

  it("trace prints the full explainable chain", async () => {
    const repo = work("cross-team");
    expect(await runCli(["build"], { cwd: repo })).toBe(0);
    const { output, result } = captureStdout(() => runCli(["trace", "CheckoutService", "createSettlement"], { cwd: repo }));
    expect(await result).toBe(0);
    const lines = output.split("\n").filter((l) => l.includes("-->"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[lines.length - 1]).toContain("createSettlement()");
  });

  it("context propose does not modify active context", async () => {
    const repo = work("cross-team");
    expect(await runCli(["build"], { cwd: repo })).toBe(0);
    const before = fs.readFileSync(path.join(repo, ".nodenet", "context.json"), "utf8");
    const { output, result } = captureStdout(() => runCli(["context", "--propose", "PAYMENT-003"], { cwd: repo }));
    expect(await result).toBe(0);
    expect(output).toContain("was NOT modified");
    const after = fs.readFileSync(path.join(repo, ".nodenet", "context.json"), "utf8");
    expect(after).toBe(before);
    expect(fs.existsSync(path.join(repo, ".nodenet", "audit.jsonl"))).toBe(true);
  });
});
