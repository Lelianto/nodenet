import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildOwnershipIndex } from "../src/ownership/resolver.js";
import { defaultConfig } from "../src/config/config.js";
import { safeRelativePath } from "../src/security/filesystem.js";
import { buildFixtureState, fixtureRoot, tmpDir } from "./helpers.js";

function rel(p: string) {
  const s = safeRelativePath(p);
  if (!s.ok) throw s.error;
  return s.value;
}

describe("ownership source priority", () => {
  it("LCDD context owner outranks NodeNet explicit ownership", () => {
    const root = fixtureRoot("cross-team");
    const state = buildFixtureState(root);
    const index = buildOwnershipIndex(state.contexts, state.config, root);
    const resolution = index.resolveOwner(rel("src/payment/PaymentService.ts"));
    expect(resolution).not.toBeNull();
    expect(resolution?.source).toBe("lcdd");
    expect(resolution?.owner).toBe("payment-team");
  });

  it("NodeNet explicit ownership outranks CODEOWNERS", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".nodenet"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".nodenet", "ownership.json"),
      JSON.stringify([
        { pattern: "lib/**", owner: "core-team", source: "nodenet", confidence: "DECLARED" },
      ]),
    );
    fs.writeFileSync(path.join(dir, "CODEOWNERS"), "lib/** @core-team\n");
    const index = buildOwnershipIndex([], defaultConfig(), dir);
    const resolution = index.resolveOwner(rel("lib/math.ts"));
    expect(resolution).not.toBeNull();
    expect(resolution?.source).toBe("nodenet");
    expect(resolution?.owner).toBe("core-team");
  });

  it("returns null when nothing matches", () => {
    const dir = tmpDir();
    const index = buildOwnershipIndex([], defaultConfig(), dir);
    expect(index.resolveOwner(rel("lib/math.ts"))).toBeNull();
  });
});
