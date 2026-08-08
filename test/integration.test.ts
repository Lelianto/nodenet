import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installAgentGuidance, uninstallAgentGuidance } from "../src/integration/installer.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent integration installer", () => {
  it("installs idempotently and removes only its marked block", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodenet-install-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# Existing guidance\n");
    expect(installAgentGuidance(root, "codex").ok).toBe(true);
    expect(installAgentGuidance(root, "codex").ok).toBe(true);
    const installed = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(installed.match(/nodenet:query-first:start/g)).toHaveLength(1);
    expect(installed).toContain("# Existing guidance");
    expect(uninstallAgentGuidance(root, "codex").ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("# Existing guidance\n");
  });
});
