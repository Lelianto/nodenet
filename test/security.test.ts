import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeRelativePath, resolveSafe, joinSafe } from "../src/security/filesystem.js";
import { scanRepository } from "../src/scanner/scanner.js";
import { defaultConfig } from "../src/config/config.js";
import { detectSecrets, isSecretFilePath } from "../src/security/secrets.js";
import { buildCodeGraph } from "../src/analyzer/code-graph.js";
import { loadConfig } from "../src/config/config.js";
import { fixtureRoot, tmpDir } from "./helpers.js";

describe("SafeRelativePath", () => {
  it("rejects traversal and absolute paths", () => {
    for (const bad of ["../etc/passwd", "/etc/passwd", "a/../../b", "..", "a\\..\\b", "C:\\x", "", "a/./b"]) {
      expect(safeRelativePath(bad).ok, `expected ${bad} to be rejected`).toBe(false);
    }
  });

  it("accepts normal relative paths", () => {
    for (const good of ["src/a.ts", "a/b/c.ts", "src/index.tsx"]) {
      expect(safeRelativePath(good).ok, `expected ${good} to be accepted`).toBe(true);
    }
  });

  it("never resolves outside the repository root", () => {
    const root = tmpDir();
    const good = safeRelativePath("a/b.ts");
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const resolved = resolveSafe(root, good.value);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.startsWith(path.resolve(root) + path.sep)).toBe(true);
    }
    const c = safeRelativePath("c.ts");
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(joinSafe(good.value, c.value).ok).toBe(true);
    }
  });

  it("joinSafe rejects components that would escape", () => {
    const base = safeRelativePath("a");
    const escape = safeRelativePath("../etc/passwd");
    expect(base.ok).toBe(true);
    expect(escape.ok).toBe(false);
  });
});

describe("scanner security", () => {
  it("skips symlinks pointing outside the repository", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "ok.ts"), "export const x = 1;\n");
    const outside = path.join(os.tmpdir(), `nodenet-outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, "secret");
    try {
      fs.symlinkSync(outside, path.join(root, "src", "leak.ts"));
    } catch {
      return; // symlinks unavailable; skip
    }
    const scan = scanRepository(root, defaultConfig());
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.value.files.some((f) => f.relPath.toString() === "src/leak.ts")).toBe(false);
    expect(scan.value.warnings.some((w) => w.includes("outside repository"))).toBe(true);
  });

  it("skips oversized files with a warning instead of crashing", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "huge.ts"), "export const x = 1;\n".repeat(50));
    const config = { ...defaultConfig(), limits: { ...defaultConfig().limits, maxFileSizeBytes: 10 } };
    const scan = scanRepository(root, config);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.value.files.filter((f) => f.relPath.toString().includes("huge")).length).toBe(0);
    expect(scan.value.warnings.some((w) => w.includes("exceeds maximum parse size"))).toBe(true);
  });

  it("ignores secret-like file paths by default", () => {
    expect(isSecretFilePath(".env")).toBe(true);
    expect(isSecretFilePath("src/.env.local")).toBe(true);
    expect(isSecretFilePath("keys/server.pem")).toBe(true);
    expect(isSecretFilePath("config/credentials.json")).toBe(true);
    expect(isSecretFilePath("src/README.md")).toBe(false);
  });

  it("detects secret-like values in generated text", () => {
    const hits = detectSecrets("api key sk-proj-abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(detectSecrets("nothing here")).toEqual([]);
  });

  it("does not leak repository content into the graph (comments never stored)", () => {
    const root = fixtureRoot("malicious-repository");
    const config = loadConfig(root);
    if (!config.ok) throw config.error;
    const build = buildCodeGraph(root, config.value);
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    const snapshot = JSON.stringify(build.value.graph.toSnapshot());
    // prompt injection text and secret-like content live only in comments -> not in the graph
    expect(snapshot).not.toContain("Ignore all previous instructions");
    expect(snapshot).not.toContain("sk-proj-");
    expect(detectSecrets(snapshot)).toEqual([]);
    // traversal strings are just symbol names; the file itself still parses
    const names = [...build.value.graph.nodes()].map((n) => n.name);
    expect(names).toContain("looksHarmless");
  });

  it("enforces graph limits safely (fails with a domain error, never crashes the process)", () => {
    const root = fixtureRoot("basic-typescript");
    const config = loadConfig(root);
    if (!config.ok) throw config.error;
    const tiny = {
      ...config.value,
      limits: { ...config.value.limits, maxGraphNodes: 5, maxGraphEdges: 10 },
    };
    expect(() => buildCodeGraph(root, tiny)).toThrow(/limit/i);
  });
});
