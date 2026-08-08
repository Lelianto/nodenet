/**
 * Governance layers (NodeNet spec §3, §5, §9).
 *
 * Merges Living Context and ownership into the same graph instance so all
 * layers are queryable as one coherent graph: ContextNode --applies_to-->
 * FileNode --owned_by--> TeamNode, ContextNode --approved_by--> TeamNode,
 * plus conflict/supersede edges between contexts.
 */

import type { Result } from "../types/result.js";
import { ok } from "../types/result.js";
import type { SafeRelativePath } from "../security/filesystem.js";
import { matchGlob } from "../utils/glob.js";
import type { Graph } from "../graph/graph.js";
import type { ContextNode, TeamNode, DeveloperNode } from "../graph/nodes.js";
import { loadContexts } from "../context/loader.js";
import type { ContextRecord } from "../context/schema.js";
import { buildOwnershipIndex, type OwnershipIndex } from "../ownership/resolver.js";
import type { LoadedConfig } from "../config/config.js";
import { makeNodeId, makeEdgeId } from "./code-graph.js";

export interface GovernanceResult {
  contexts: ContextRecord[];
  ownership: OwnershipIndex;
  warnings: string[];
}

export function attachGovernanceLayers(
  graph: Graph,
  root: string,
  config: LoadedConfig,
): Result<GovernanceResult, Error> {
  const warnings: string[] = [];
  const contextLoad = loadContexts(root);
  if (!contextLoad.ok) return contextLoad;
  const contexts = contextLoad.value.contexts;
  warnings.push(...contextLoad.value.warnings);

  const ownership = buildOwnershipIndex(contexts, config, root);

  // -- teams ----------------------------------------------------------------
  const ensureTeam = (name: string): TeamNode => {
    const id = makeNodeId("team", name);
    const existing = graph.getNode(id);
    if (existing && existing.kind === "team") return existing;
    const node: TeamNode = { kind: "team", id, name, teamId: name };
    graph.addNode(node);
    return node;
  };
  const ensureDeveloper = (handle: string): DeveloperNode => {
    const id = makeNodeId("developer", handle);
    const existing = graph.getNode(id);
    if (existing && existing.kind === "developer") return existing;
    const node: DeveloperNode = { kind: "developer", id, name: handle, handle };
    graph.addNode(node);
    return node;
  };
  const teamOrPerson = (target: string): TeamNode | DeveloperNode => {
    return target.startsWith("@") ? ensureDeveloper(target) : ensureTeam(target);
  };

  // teams declared in config
  for (const [teamId, meta] of Object.entries(config.ownership.teams)) {
    const team = ensureTeam(teamId);
    if (meta.name) {
      graph.addNode({ ...team, name: meta.name });
    }
    for (const member of meta.members ?? []) {
      const dev = ensureDeveloper(member);
      graph.addEdge({
        id: makeEdgeId(dev.id, "member_of", team.id),
        from: dev.id,
        to: team.id,
        relation: "member_of",
        provenance: { source: "config" },
      });
    }
  }

  // -- contexts ---------------------------------------------------------------
  const contextIds = new Set(contexts.map((c) => c.id));
  for (const ctx of contexts) {
    const node: ContextNode = {
      kind: ctx.type,
      id: makeNodeId("context", ctx.id),
      name: ctx.title,
      contextId: ctx.id,
      status: ctx.status,
      authority: ctx.authority,
      type: ctx.type,
      ...(ctx.governanceClassification !== undefined ? { governanceClassification: ctx.governanceClassification } : {}),
      approvalRequired: ctx.approvalRequired,
      ...(ctx.enforcementMode !== undefined ? { enforcementMode: ctx.enforcementMode } : {}),
      ...(ctx.sourceFormat !== undefined ? { sourceFormat: ctx.sourceFormat } : {}),
    };
    graph.addNode(node);

    // applies_to -> matching files
    for (const pattern of ctx.appliesTo) {
      for (const fileNode of graph.findNodes((n) => n.kind === "file")) {
        if (matchGlob(pattern, (fileNode as { path: SafeRelativePath }).path.toString())) {
          graph.addEdge({
            id: makeEdgeId(node.id, "applies_to", fileNode.id),
            from: node.id,
            to: fileNode.id,
            relation: "applies_to",
            provenance: { source: "context-file" },
          });
        }
      }
    }

    // approved_by -> teams/persons
    for (const approver of ctx.approvedBy) {
      const target = teamOrPerson(approver);
      graph.addEdge({
        id: makeEdgeId(node.id, "approved_by", target.id),
        from: node.id,
        to: target.id,
        relation: "approved_by",
        provenance: { source: "context-file" },
      });
    }

    // owner -> responsible_for
    if (ctx.owner) {
      const target = teamOrPerson(ctx.owner);
      graph.addEdge({
        id: makeEdgeId(target.id, "responsible_for", node.id),
        from: target.id,
        to: node.id,
        relation: "responsible_for",
        provenance: { source: "context-file" },
      });
    }

    // conflicts / supersedes
    for (const otherId of ctx.conflictsWith ?? []) {
      if (!contextIds.has(otherId)) continue;
      const otherNodeId = makeNodeId("context", otherId);
      if (graph.hasNode(otherNodeId)) {
        graph.addEdge({
          id: makeEdgeId(node.id, "conflicts_with", otherNodeId),
          from: node.id,
          to: otherNodeId,
          relation: "conflicts_with",
          provenance: { source: "context-file" },
        });
      }
    }
    for (const otherId of ctx.supersedes ?? []) {
      if (!contextIds.has(otherId)) continue;
      const otherNodeId = makeNodeId("context", otherId);
      if (graph.hasNode(otherNodeId)) {
        graph.addEdge({
          id: makeEdgeId(node.id, "supersedes", otherNodeId),
          from: node.id,
          to: otherNodeId,
          relation: "supersedes",
          provenance: { source: "context-file" },
        });
      }
    }
  }

  // -- ownership edges ----------------------------------------------------------
  for (const record of ownership.records) {
    for (const fileNode of graph.findNodes((n) => n.kind === "file")) {
      const p = (fileNode as { path: SafeRelativePath }).path.toString();
      if (!matchGlob(record.pattern, p)) continue;
      const target = teamOrPerson(record.owner);
      graph.addEdge({
        id: makeEdgeId(fileNode.id, "owned_by", target.id),
        from: fileNode.id,
        to: target.id,
        relation: "owned_by",
        provenance: { source: record.source === "git-history" ? "git-history" : (record.source as "config" | "codeowners" | "context-file") },
      });
    }
  }

  return ok({ contexts, ownership, warnings });
}
