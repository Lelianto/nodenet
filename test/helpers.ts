import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function fixtureRoot(name: string): string {
  return path.join(process.cwd(), "test", "fixtures", name);
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nodenet-test-"));
}

export function copyFixture(name: string, dest: string): void {
  fs.cpSync(fixtureRoot(name), dest, { recursive: true });
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
