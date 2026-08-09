import fs from "node:fs";
import { errorMessage } from "../types/result.js";

/** Narrow an untrusted value before reading any of its properties. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse untrusted JSON while retaining useful context in the resulting error. */
export function parseJson(text: string, source = "JSON input"): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`Cannot parse ${source}: ${errorMessage(cause)}`, { cause });
  }
}

/** Read JSON without pretending its runtime shape is already known. */
export function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (cause) {
    throw new Error(`Cannot read ${file}: ${errorMessage(cause)}`, { cause });
  }
  return parseJson(text, file);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
