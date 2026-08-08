import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodeGraph } from "../src/analyzer/code-graph.js";
import { loadConfig } from "../src/config/config.js";
import { languageSupportMatrix, registeredLanguageAdapters } from "../src/parser/registry.js";
import { tmpDir } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("local artifact ingestion", () => {
  it("extracts ADR, OpenAPI operations, SQL tables, and Terraform resources", () => {
    const root = tmpDir(); roots.push(root);
    fs.mkdirSync(path.join(root, "docs", "adr"), { recursive: true });
    fs.mkdirSync(path.join(root, "db"), { recursive: true });
    fs.mkdirSync(path.join(root, "infra"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"artifacts"}');
    fs.writeFileSync(path.join(root, "docs", "adr", "001.md"), "# Use payment ledger\n");
    fs.writeFileSync(path.join(root, "openapi.yaml"), "openapi: 3.1.0\npaths:\n  /payments:\n    post:\n");
    fs.writeFileSync(path.join(root, "db", "schema.sql"), "CREATE TABLE payment_events (id text);\n");
    fs.writeFileSync(path.join(root, "infra", "main.tf"), 'resource "aws_lambda_function" "payments" {}\n');
    const config = loadConfig(root); if (!config.ok) throw config.error;
    const build = buildCodeGraph(root, config.value); if (!build.ok) throw build.error;
    const kinds = [...build.value.graph.nodes()].map((node) => node.kind);
    expect(kinds).toContain("document");
    expect(kinds).toContain("apiOperation");
    expect(kinds).toContain("databaseTable");
    expect(kinds).toContain("infrastructureResource");
    expect([...build.value.graph.edges()].some((edge) => edge.relation === "defines")).toBe(true);
  });

  it("exposes a replaceable language adapter registry", () => {
    expect(registeredLanguageAdapters()).toHaveLength(9);
    const matrix = languageSupportMatrix();
    expect(matrix).toHaveLength(10);
    expect(matrix.filter((language) => language.tier === "full").map((language) => language.language)).toEqual(["typescript", "javascript", "python", "go", "java", "csharp", "php"]);
    expect(matrix.filter((language) => language.tier === "basic").map((language) => language.language)).toEqual(["rust", "ruby", "kotlin"]);
  });

  it("maps declarations in the web-focused language set", () => {
    const root = tmpDir(); roots.push(root);
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"ten-languages"}');
    const sources: Record<string, string> = {
      "worker.rs": "use std::sync::Arc;\nstruct RustWorker {}\nfn process() {}\n",
      "Worker.cs": "using System;\npublic class CSharpWorker {\n  public void Run() {}\n  private void Reset() {}\n}\n",
      "worker.php": "<?php\nuse App\\Ledger;\nclass PhpWorker {\n  public function settle() {}\n  private function reset() {}\n}\n",
      "worker.rb": "require 'json'\nclass RubyWorker\n  def settle\n  end\nend\n",
      "Worker.kt": "import kotlin.time.Duration\nclass KotlinWorker\nfun settle() {}\n",
    };
    for (const [file, source] of Object.entries(sources)) fs.writeFileSync(path.join(root, file), source);
    const config = loadConfig(root); if (!config.ok) throw config.error;
    const build = buildCodeGraph(root, config.value); if (!build.ok) throw build.error;
    const languages = [...build.value.graph.nodes()].filter((node) => node.kind === "file").map((node) => node.language);
    expect(languages).toEqual(expect.arrayContaining(["rust", "csharp", "php", "ruby", "kotlin"]));
    for (const name of ["RustWorker", "CSharpWorker", "PhpWorker", "RubyWorker", "KotlinWorker"]) {
      expect([...build.value.graph.nodes()].some((node) => node.name === name)).toBe(true);
    }
    const nodes = [...build.value.graph.nodes()];
    expect(nodes.some((node) => node.kind === "method" && node.name === "Run" && node.exported)).toBe(true);
    expect(nodes.some((node) => node.kind === "method" && node.name === "Reset" && !node.exported)).toBe(true);
    expect(nodes.some((node) => node.kind === "method" && node.name === "settle" && node.exported)).toBe(true);
    expect(nodes.some((node) => node.kind === "method" && node.name === "reset" && !node.exported)).toBe(true);
  });

  it("maps Python, Go, and Java declarations locally", () => {
    const root = tmpDir(); roots.push(root);
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"polyglot"}');
    fs.writeFileSync(path.join(root, "service.py"), "import json\nclass PaymentService:\n    def settle(self):\n        pass\n");
    fs.writeFileSync(path.join(root, "worker.go"), 'package worker\nimport "context"\ntype Worker struct {}\nfunc Run() {}\n');
    fs.writeFileSync(path.join(root, "PaymentController.java"), "import java.util.List;\npublic class PaymentController {\n  public void settle() {}\n}\n");
    const config = loadConfig(root); if (!config.ok) throw config.error;
    const build = buildCodeGraph(root, config.value); if (!build.ok) throw build.error;
    const nodes = [...build.value.graph.nodes()];
    expect(nodes.some((node) => node.name === "PaymentService" && node.kind === "class")).toBe(true);
    expect(nodes.some((node) => node.name === "Worker" && node.kind === "class")).toBe(true);
    expect(nodes.some((node) => node.name === "Run" && node.kind === "function")).toBe(true);
    expect(nodes.some((node) => node.name === "PaymentController" && node.kind === "class")).toBe(true);
  });

  it("reuses unchanged parse results during an incremental rebuild", () => {
    const root = tmpDir(); roots.push(root);
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"incremental"}');
    fs.writeFileSync(path.join(root, "index.ts"), "export function ready() { return true; }\n");
    const config = loadConfig(root); if (!config.ok) throw config.error;
    const first = buildCodeGraph(root, config.value, { incrementalCache: true }); if (!first.ok) throw first.error;
    const second = buildCodeGraph(root, config.value, { incrementalCache: true }); if (!second.ok) throw second.error;
    expect(first.value.incremental.parsed).toBe(1);
    expect(second.value.incremental).toEqual({ parsed: 0, reused: 1 });
  });
});
