import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeChangeCollisions } from "../src/change/collisions.js";
import { buildFixtureState, makeGitRepo } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("multi-change collisions", () => {
  it("triages two local branches touching the same governed file", () => {
    const root = makeGitRepo("cross-team"); roots.push(root);
    for (const [branch, suffix] of [["feature-a", "// a\n"], ["feature-b", "// b\n"]] as const) {
      execSync(`git checkout -q -b ${branch} main`, { cwd: root });
      fs.appendFileSync(path.join(root, "src", "payment", "PaymentService.ts"), suffix);
      execSync("git add .", { cwd: root });
      execSync(`git commit -q -m ${branch}`, { cwd: root });
    }
    execSync("git checkout -q main", { cwd: root });
    const state = buildFixtureState(root);
    const report = analyzeChangeCollisions(root, "main", ["feature-a", "feature-b"], state.graph, state.index, state.contexts, state.ownership);
    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0]?.sharedFiles).toContain("src/payment/PaymentService.ts");
    expect(report.collisions[0]?.sharedContexts).toContain("SEC-009");
    expect(report.reviewOrder).toHaveLength(2);
  });
});
