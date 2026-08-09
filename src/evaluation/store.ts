import fs from "node:fs";
import path from "node:path";
import { dotNodenetDir } from "../storage/storage.js";
import type { EvaluationDataset, EvaluationLabel, EvaluationRun } from "./types.js";

function evaluationDir(root: string): string { return path.join(dotNodenetDir(root), "evaluation"); }
function safeId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Invalid evaluation identifier: ${id}`);
  return id;
}

export function saveDataset(root: string, dataset: EvaluationDataset): string {
  const dir = path.join(evaluationDir(root), "datasets");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeId(dataset.id)}.json`);
  fs.writeFileSync(file, JSON.stringify(dataset, null, 2) + "\n", { mode: 0o600 });
  return file;
}

export function loadDataset(root: string, id: string): EvaluationDataset {
  const file = path.join(evaluationDir(root), "datasets", `${safeId(id)}.json`);
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as EvaluationDataset;
  if (value.schemaVersion !== "1" || !Array.isArray(value.cases)) throw new Error(`Invalid evaluation dataset: ${id}`);
  return value;
}

export function saveLabel(root: string, label: EvaluationLabel): string {
  const dir = path.join(evaluationDir(root), "labels", safeId(label.datasetId));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label.pullRequest}.json`);
  fs.writeFileSync(file, JSON.stringify(label, null, 2) + "\n", { mode: 0o600 });
  return file;
}

export function loadLabels(root: string, datasetId: string): EvaluationLabel[] {
  const dir = path.join(evaluationDir(root), "labels", safeId(datasetId));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) =>
    JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as EvaluationLabel,
  );
}

export function saveEvaluationRun(root: string, run: EvaluationRun): string {
  const dir = path.join(evaluationDir(root), "runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeId(run.id)}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n", { mode: 0o600 });
  return file;
}

export function loadEvaluationRun(root: string, id: string): EvaluationRun {
  const file = path.join(evaluationDir(root), "runs", `${safeId(id)}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as EvaluationRun;
}
