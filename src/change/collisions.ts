/** Multi-branch collision analysis using only local git and the persisted graph. */
import { execFileSync } from "node:child_process";
import type { Graph } from "../graph/graph.js";
import type { CodeGraphIndex } from "../analyzer/code-graph.js";
import type { ContextRecord } from "../context/schema.js";
import type { OwnershipIndex } from "../ownership/resolver.js";
import { matchGlob } from "../utils/glob.js";
import { safeRelativePath } from "../security/filesystem.js";

export interface ChangeSetSummary {
  ref: string;
  files: string[];
  nodeIds: string[];
  contexts: string[];
  owners: string[];
  risk: number;
}

export interface ChangeCollision {
  left: string;
  right: string;
  sharedFiles: string[];
  sharedNodes: string[];
  sharedContexts: string[];
  sharedOwners: string[];
  severity: "LOW" | "MEDIUM" | "HIGH";
  reasons: string[];
}

export interface CollisionReport {
  base: string;
  changes: ChangeSetSummary[];
  collisions: ChangeCollision[];
  reviewOrder: string[];
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function changedFiles(root: string, base: string, ref: string): string[] {
  const mergeBase = git(root, ["merge-base", base, ref]);
  const output = git(root, ["diff", "--name-only", "--diff-filter=ACMR", `${mergeBase}..${ref}`, "--"]);
  return output ? output.split("\n").filter(Boolean).sort() : [];
}

function intersection(a: string[], b: string[]): string[] {
  const right = new Set(b);
  return [...new Set(a.filter((value) => right.has(value)))].sort();
}

export function analyzeChangeCollisions(
  root: string,
  base: string,
  refs: string[],
  graph: Graph,
  index: CodeGraphIndex,
  contexts: ContextRecord[],
  ownership: OwnershipIndex,
): CollisionReport {
  const changes = [...new Set(refs)].map((ref): ChangeSetSummary => {
    const files = changedFiles(root, base, ref);
    const nodeIds = new Set<string>();
    for (const file of files) {
      for (const [safe, id] of index.fileNodes) {
        if (safe.toString() !== file) continue;
        nodeIds.add(id);
        for (const edge of graph.out(id)) if (edge.relation === "contains") nodeIds.add(edge.to);
      }
    }
    const affectedContexts = contexts.filter((context) => files.some((file) => context.appliesTo.some((pattern) => matchGlob(pattern, file))));
    const owners = files.flatMap((file) => {
      const safe = safeRelativePath(file);
      if (!safe.ok) return [];
      const resolved = ownership.resolveOwner(safe.value);
      return resolved ? [resolved.owner] : [];
    });
    const risk = files.length + nodeIds.size * 2 + affectedContexts.length * 5 + new Set(owners).size * 3;
    return { ref, files, nodeIds: [...nodeIds].sort(), contexts: affectedContexts.map((context) => context.id).sort(), owners: [...new Set(owners)].sort(), risk };
  });
  const collisions: ChangeCollision[] = [];
  for (let i = 0; i < changes.length; i++) for (let j = i + 1; j < changes.length; j++) {
    const left = changes[i];
    const right = changes[j];
    if (!left || !right) continue;
    const sharedFiles = intersection(left.files, right.files);
    const sharedNodes = intersection(left.nodeIds, right.nodeIds);
    const sharedContexts = intersection(left.contexts, right.contexts);
    const sharedOwners = intersection(left.owners, right.owners);
    const score = sharedFiles.length * 5 + sharedNodes.length * 2 + sharedContexts.length * 6 + sharedOwners.length;
    if (score === 0) continue;
    const reasons = [
      ...(sharedFiles.length ? [`${sharedFiles.length} shared file(s)`] : []),
      ...(sharedNodes.length ? [`${sharedNodes.length} shared graph node(s)`] : []),
      ...(sharedContexts.length ? [`shared context: ${sharedContexts.join(", ")}`] : []),
      ...(sharedOwners.length ? [`shared ownership boundary: ${sharedOwners.join(", ")}`] : []),
    ];
    collisions.push({ left: left.ref, right: right.ref, sharedFiles, sharedNodes, sharedContexts, sharedOwners, severity: score >= 12 ? "HIGH" : score >= 5 ? "MEDIUM" : "LOW", reasons });
  }
  collisions.sort((a, b) => ({ HIGH: 3, MEDIUM: 2, LOW: 1 })[b.severity] - ({ HIGH: 3, MEDIUM: 2, LOW: 1 })[a.severity]);
  return { base, changes, collisions, reviewOrder: [...changes].sort((a, b) => b.risk - a.risk || a.ref.localeCompare(b.ref)).map((change) => change.ref) };
}
