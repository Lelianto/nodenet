import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, isValidRef } from "../src/change/diff.js";

const SAMPLE = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -3,2 +3,2 @@ export function main(): number {
   const v: Vec = { x: 1, y: 2 };
-  return add(PI, dot(v, v));
+  return add(PI, dot(v, v)) * 2;
 }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export function fresh(): number {
+  return 1;
+}
diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
index 1234567..0000000
--- a/src/removed.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export function gone(): number {
-  return 0;
-}
`;

describe("parseUnifiedDiff", () => {
  it("extracts symbol-level line changes from hunks", () => {
    const hunks = parseUnifiedDiff(SAMPLE);
    const app = hunks.find((h) => h.relPath.toString() === "src/app.ts");
    expect(app).toBeDefined();
    // line 4 changed (the return statement)
    expect(app!.addedLines).toContain(4);
    expect(app!.removedLineCount).toBeGreaterThanOrEqual(1);
  });

  it("detects new files", () => {
    const hunks = parseUnifiedDiff(SAMPLE);
    const fresh = hunks.find((h) => h.relPath.toString() === "src/new.ts");
    expect(fresh?.isNewFile).toBe(true);
    expect(fresh!.addedLines).toContain(1);
  });

  it("detects deleted files", () => {
    const hunks = parseUnifiedDiff(SAMPLE);
    const removed = hunks.find((h) => h.relPath.toString() === "src/removed.ts");
    expect(removed?.isDeletedFile).toBe(true);
  });

  it("adds untracked files as new files", () => {
    const hunks = parseUnifiedDiff("", "src/untracked.ts\nsrc/also.ts\n");
    const names = hunks.map((h) => h.relPath.toString());
    expect(names).toContain("src/untracked.ts");
    expect(names).toContain("src/also.ts");
    expect(hunks.every((h) => h.isNewFile)).toBe(true);
  });
});

describe("isValidRef", () => {
  it("rejects shell metacharacters and injection vectors", () => {
    expect(isValidRef("main")).toBe(true);
    expect(isValidRef("feature/foo-1")).toBe(true);
    expect(isValidRef("main; rm -rf /")).toBe(false);
    expect(isValidRef("--upload-pack=evil")).toBe(false);
    expect(isValidRef("-x")).toBe(false);
    expect(isValidRef("$(whoami)")).toBe(false);
    expect(isValidRef("main..HEAD")).toBe(false);
  });
});
