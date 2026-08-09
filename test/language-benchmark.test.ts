import { describe, expect, it } from "vitest";
import { BUILTIN_LANGUAGE_BENCHMARK, runLanguageBenchmark } from "../src/evaluation/language-benchmark.js";

describe("ten-language executable benchmark", () => {
  it("covers every supported language with positive and false-positive contracts", () => {
    const languages = new Set(BUILTIN_LANGUAGE_BENCHMARK.map((item) => item.language));
    expect(languages.size).toBe(10);
    for (const language of languages) expect(BUILTIN_LANGUAGE_BENCHMARK.filter((item) => item.language === language)).toHaveLength(2);
  });

  it("runs adapters and reports per-language precision and recall", () => {
    const report = runLanguageBenchmark();
    expect(report.cases).toBe(20);
    expect(report.languages).toHaveLength(10);
    for (const row of report.languages) {
      expect(row.symbolPrecision).toBeGreaterThanOrEqual(0.5);
      expect(row.symbolRecall).toBeGreaterThanOrEqual(0.5);
    }
  });
});
