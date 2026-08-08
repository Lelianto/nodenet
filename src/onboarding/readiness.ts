import fs from "node:fs";
import path from "node:path";
import type { AnalysisState } from "../types/analysis-state.js";

export interface ReadinessCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
  action?: string;
}

export interface ReadinessReport {
  ready: boolean;
  score: number;
  checks: ReadinessCheck[];
}

export function assessReadiness(root: string, state: AnalysisState): ReadinessReport {
  const checks: ReadinessCheck[] = [
    fs.existsSync(path.join(root, "nodenet.config.json"))
      ? { id: "config", status: "pass", message: "NodeNet configuration exists." }
      : { id: "config", status: "warn", message: "Using default configuration.", action: "Run nodenet bootstrap." },
    state.graph.size > 0
      ? { id: "graph", status: "pass", message: `Graph contains ${state.graph.size} nodes and ${state.graph.edgeCount} edges.` }
      : { id: "graph", status: "fail", message: "Graph is empty.", action: "Check ignore patterns and supported source files." },
    state.contexts.length > 0
      ? { id: "contexts", status: "pass", message: `${state.contexts.length} governance context(s) loaded.` }
      : { id: "contexts", status: "warn", message: "No governance contexts found.", action: "Add an LCDD 0.6 Context under .lcdd/contexts/." },
    state.ownership.records.length > 0
      ? { id: "ownership", status: "pass", message: `${state.ownership.records.length} ownership rule(s) found.` }
      : { id: "ownership", status: "warn", message: "No ownership mappings resolved.", action: "Add CODEOWNERS or ownership overrides." },
    fs.existsSync(path.join(root, ".github", "workflows", "nodenet-governance.yml"))
      ? { id: "github", status: "pass", message: "GitHub governance workflow is installed." }
      : { id: "github", status: "warn", message: "GitHub governance workflow is not installed.", action: "Run nodenet bootstrap --github." },
  ];
  const points = checks.reduce((sum, check) => sum + (check.status === "pass" ? 20 : check.status === "warn" ? 10 : 0), 0);
  const requiredGovernance = checks
    .filter((check) => check.id === "contexts" || check.id === "ownership")
    .every((check) => check.status === "pass");
  return { ready: !checks.some((check) => check.status === "fail") && requiredGovernance && points >= 80, score: points, checks };
}
