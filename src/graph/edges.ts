/**
 * Typed graph edges (NodeNet spec §33).
 *
 * Edges carry a literal `relation` and a provenance block so every
 * relationship is explainable (spec §4). Invalid source/target kind
 * combinations are rejected at construction time via the validation table
 * below.
 */

import type { EdgeId, NodeId } from "../types/brand.js";
import { InvalidEdgeError } from "../types/result.js";
import { CONTEXT_NODE_KINDS, type GraphNode, type NodeKind } from "./nodes.js";

// ---------------------------------------------------------------------------
// Relation literals
// ---------------------------------------------------------------------------

/** Code relationships (spec §4). */
export const CODE_RELATIONS = [
  "contains",
  "imports",
  "exports",
  "reexports",
  "calls",
  "references",
  "uses",
  "implements",
  "extends",
  "renders",
  "tests",
  "configures",
  "depends_on",
  "documents",
  "defines",
  "deploys",
] as const;
export type CodeRelation = (typeof CODE_RELATIONS)[number];

/** Living Context relationships (spec §5). */
export const CONTEXT_RELATIONS = [
  "governed_by",
  "constrained_by",
  "implements_context",
  "validated_by",
  "supersedes",
  "conflicts_with",
  "derived_from",
  "applies_to",
] as const;
export type ContextRelation = (typeof CONTEXT_RELATIONS)[number];

/** Ownership relationships (spec §9). */
export const OWNERSHIP_RELATIONS = [
  "owned_by",
  "approved_by",
  "maintains",
  "reviews",
  "member_of",
  "responsible_for",
] as const;
export type OwnershipRelation = (typeof OWNERSHIP_RELATIONS)[number];

/** Ephemeral change-graph relationships (spec §12). */
export const CHANGE_RELATIONS = ["affects", "modifies"] as const;
export type ChangeRelation = (typeof CHANGE_RELATIONS)[number];

export type Relation =
  | CodeRelation
  | ContextRelation
  | OwnershipRelation
  | ChangeRelation;

export const ALL_RELATIONS = [
  ...CODE_RELATIONS,
  ...CONTEXT_RELATIONS,
  ...OWNERSHIP_RELATIONS,
  ...CHANGE_RELATIONS,
] as const satisfies readonly Relation[];

// ---------------------------------------------------------------------------
// Provenance — every edge must be explainable
// ---------------------------------------------------------------------------

export type EdgeSource =
  | "ast"
  | "config"
  | "context-file"
  | "codeowners"
  | "git-history"
  | "user"
  | "inferred"
  | "change-analysis";

export const EVIDENCE_CLASSES = ["EXTRACTED", "DECLARED", "INFERRED", "AMBIGUOUS", "OBSERVED"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export function evidenceClassForSource(source: EdgeSource): EvidenceClass {
  if (source === "ast" || source === "config") return "EXTRACTED";
  if (source === "context-file" || source === "codeowners" || source === "user") return "DECLARED";
  if (source === "inferred" || source === "git-history") return "INFERRED";
  return source === "change-analysis" ? "OBSERVED" : "AMBIGUOUS";
}

export interface EdgeProvenance {
  /** Where this edge came from. */
  source: EdgeSource;
  /** Trust category independent from the concrete source. */
  classification?: EvidenceClass;
  /** Human-readable location, e.g. `src/app.ts:12`. */
  location?: string;
  /** Optional explanation for inferred or ambiguous claims. */
  rationale?: string;
}

// ---------------------------------------------------------------------------
// Edge shape
// ---------------------------------------------------------------------------

export interface GraphEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  relation: Relation;
  provenance: EdgeProvenance;
}

// ---------------------------------------------------------------------------
// Relation validity — invalid combinations are rejected at construction
// ---------------------------------------------------------------------------

/**
 * Allowed (fromKind, toKind) pairs per relation. Missing entries are
 * rejected. `*` matches any kind.
 */
export const RELATION_RULES: Record<Relation, { from: NodeKind[] | "*"; to: NodeKind[] | "*" }> = {
  contains: { from: ["repository", "workspace", "package", "directory"], to: "*" },
  imports: { from: ["file"], to: ["file", "package"] },
  exports: { from: ["file"], to: "*" },
  reexports: { from: ["file"], to: ["file"] },
  calls: { from: "*", to: ["function", "method", "reactComponent", "reactHook"] },
  references: { from: "*", to: ["interface", "typeAlias", "enum", "file"] },
  uses: { from: "*", to: ["class", "variable", "function", "method"] },
  implements: { from: ["class"], to: ["class", "interface"] },
  extends: { from: ["class", "interface"], to: ["class", "interface"] },
  renders: { from: ["reactComponent", "reactHook"], to: ["reactComponent"] },
  tests: { from: ["test", "file"], to: ["file", "function", "method", "class"] },
  configures: { from: ["configuration"], to: ["repository", "workspace", "package", "file"] },
  depends_on: { from: ["file", "package", "workspace"], to: ["package", "workspace", "file"] },
  documents: { from: ["document"], to: "*" },
  defines: { from: ["document", "configuration"], to: ["apiOperation", "databaseTable", "infrastructureResource"] },
  deploys: { from: ["infrastructureResource"], to: ["package", "file", "apiOperation"] },
  governed_by: { from: "*", to: [...CONTEXT_NODE_KINDS] },
  constrained_by: { from: "*", to: [...CONTEXT_NODE_KINDS] },
  implements_context: { from: "*", to: [...CONTEXT_NODE_KINDS] },
  validated_by: { from: "*", to: [...CONTEXT_NODE_KINDS] },
  supersedes: { from: [...CONTEXT_NODE_KINDS], to: [...CONTEXT_NODE_KINDS] },
  conflicts_with: { from: [...CONTEXT_NODE_KINDS], to: [...CONTEXT_NODE_KINDS] },
  derived_from: { from: [...CONTEXT_NODE_KINDS], to: [...CONTEXT_NODE_KINDS] },
  applies_to: { from: [...CONTEXT_NODE_KINDS], to: "*" },
  owned_by: { from: ["file", "directory", "package", "workspace", "class", "function", "method"], to: ["team", "developer", "role"] },
  approved_by: { from: [...CONTEXT_NODE_KINDS], to: ["team", "developer", "role"] },
  maintains: { from: ["team", "developer"], to: ["file", "directory", "package"] },
  reviews: { from: ["team", "developer", "role"], to: "*" },
  member_of: { from: ["developer", "role"], to: ["team"] },
  responsible_for: { from: ["team", "developer", "role"], to: "*" },
  affects: { from: "*", to: "*" },
  modifies: { from: "*", to: "*" },
};

function kindMatches(rule: NodeKind[] | "*", kind: NodeKind): boolean {
  return rule === "*" || (rule as readonly NodeKind[]).includes(kind);
}

/** Returns true when a `from` node kind may relate to a `to` node kind. */
export function isRelationAllowed(relation: Relation, fromKind: NodeKind, toKind: NodeKind): boolean {
  const rule = RELATION_RULES[relation];
  if (!rule) return false;
  return kindMatches(rule.from, fromKind) && kindMatches(rule.to, toKind);
}

/** Throws an InvalidEdgeError when the relation is not allowed. */
export function assertRelationAllowed(
  relation: Relation,
  from: GraphNode,
  to: GraphNode,
): void {
  if (!isRelationAllowed(relation, from.kind, to.kind)) {
    throw new InvalidEdgeError(
      `Invalid edge: ${from.kind} --${relation}--> ${to.kind} is not an allowed relationship.`,
    );
  }
}
