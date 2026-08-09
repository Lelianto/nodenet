import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAccessPolicy } from "../src/identity/rbac.js";
import { isRecord, parseJson, readJsonFile } from "../src/utils/validation.js";
import { tmpDir } from "./helpers.js";

describe("untrusted data validation", () => {
  it("narrows records without accepting arrays or null", () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it("adds source context and preserves the parse error as its cause", () => {
    expect(() => parseJson("{", "request body")).toThrow("Cannot parse request body");
    try {
      parseJson("{", "request body");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
  });

  it("reports file context when JSON cannot be read", () => {
    const file = path.join(tmpDir(), "missing.json");
    expect(() => readJsonFile(file)).toThrow(`Cannot read ${file}`);
  });

  it("rejects malformed access bindings instead of returning typed undefined values", () => {
    const root = tmpDir();
    const dir = path.join(root, ".nodenet");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "access.json"), JSON.stringify({
      schemaVersion: "1",
      bindings: [{ githubUserId: 1, role: "override-approver", repositories: ["repo"], contextPatterns: undefined }],
    }));
    expect(() => loadAccessPolicy(root)).toThrow("repository and context patterns must be string arrays");
  });
});
