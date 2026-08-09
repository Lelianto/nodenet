/**
 * Discriminated graph node union (NodeNet spec §32).
 *
 * Every node carries a literal `kind`, so exhaustive switches and runtime
 * validation are possible. No loosely-typed `{ type: string, data: ... }`
 * nodes exist anywhere in NodeNet.
 */

import type { SafeRelativePath } from "../security/filesystem.js";
import type { NodeId } from "../types/brand.js";
import type { Language } from "../parser/typescript.js";
import type { AuthorityLevel } from "../authority/authority.js";
import type { ContextLifecycleStatus, ContextType } from "../context/schema.js";

// ---------------------------------------------------------------------------
// Kind literals
// ---------------------------------------------------------------------------

/** Code-layer node kinds (spec §4). */
export const CODE_NODE_KINDS = [
  "repository",
  "workspace",
  "package",
  "directory",
  "file",
  "function",
  "method",
  "class",
  "interface",
  "typeAlias",
  "enum",
  "variable",
  "reactComponent",
  "reactHook",
  "apiRoute",
  "middleware",
  "test",
  "configuration",
  "document",
  "apiOperation",
  "databaseTable",
  "infrastructureResource",
] as const;
export type CodeNodeKind = (typeof CODE_NODE_KINDS)[number];

/** Living Context-layer node kinds (spec §5). */
export const CONTEXT_NODE_KINDS = [
  "businessRule",
  "architectureDecision",
  "securityPolicy",
  "codingConvention",
  "requirement",
  "specification",
  "complianceRule",
  "operationalRule",
  "incidentLearning",
  "assumption",
  "domainRule",
  "externalConstraint",
] as const;
export type ContextNodeKind = (typeof CONTEXT_NODE_KINDS)[number];

/** Ownership-layer node kinds (spec §9). */
export const ACTOR_NODE_KINDS = ["developer", "team", "role"] as const;
export type ActorNodeKind = (typeof ACTOR_NODE_KINDS)[number];

export type NodeKind = CodeNodeKind | ContextNodeKind | ActorNodeKind;

// ---------------------------------------------------------------------------
// Shared fields
// ---------------------------------------------------------------------------

export interface NodeBase {
  id: NodeId;
  name: string;
}

// ---------------------------------------------------------------------------
// Code nodes
// ---------------------------------------------------------------------------

export interface RepositoryNode extends NodeBase {
  kind: "repository";
  root: string;
}

export interface WorkspaceNode extends NodeBase {
  kind: "workspace";
}

export interface PackageNode extends NodeBase {
  kind: "package";
  /** True when the package is external (a bare import not resolvable in-repo). */
  external: boolean;
  path?: SafeRelativePath;
}

export interface DirectoryNode extends NodeBase {
  kind: "directory";
  path: SafeRelativePath;
}

export interface FileNode extends NodeBase {
  kind: "file";
  path: SafeRelativePath;
  language: Language;
  isTest: boolean;
}

export interface FunctionNode extends NodeBase {
  kind: "function";
  path: SafeRelativePath;
  line: number;
  exported: boolean;
}

export interface MethodNode extends NodeBase {
  kind: "method";
  path: SafeRelativePath;
  line: number;
  className: string;
  exported: boolean;
}

export interface ClassNode extends NodeBase {
  kind: "class";
  path: SafeRelativePath;
  line: number;
  exported: boolean;
}

export interface InterfaceNode extends NodeBase {
  kind: "interface";
  path: SafeRelativePath;
  line: number;
  exported: boolean;
}

export interface TypeAliasNode extends NodeBase {
  kind: "typeAlias";
  path: SafeRelativePath;
  line: number;
  exported: boolean;
}

export interface EnumNode extends NodeBase {
  kind: "enum";
  path: SafeRelativePath;
  line: number;
  exported: boolean;
}

export interface VariableNode extends NodeBase {
  kind: "variable";
  path: SafeRelativePath;
  line: number;
  exported: boolean;
}

export interface ReactComponentNode extends NodeBase {
  kind: "reactComponent";
  path: SafeRelativePath;
  line: number;
  exported: boolean;
}

export interface ReactHookNode extends NodeBase {
  kind: "reactHook";
  path: SafeRelativePath;
  line: number;
  exported: boolean;
}

export interface ApiRouteNode extends NodeBase {
  kind: "apiRoute";
  path: SafeRelativePath;
  line: number;
  method?: string;
}

export interface MiddlewareNode extends NodeBase {
  kind: "middleware";
  path: SafeRelativePath;
}

export interface TestNode extends NodeBase {
  kind: "test";
  path: SafeRelativePath;
}

export interface ConfigurationNode extends NodeBase {
  kind: "configuration";
  path: SafeRelativePath;
}

export interface ArtifactNode extends NodeBase {
  kind: "document" | "apiOperation" | "databaseTable" | "infrastructureResource";
  path: SafeRelativePath;
  line?: number;
  artifactType: "adr" | "markdown" | "openapi" | "sql" | "terraform" | "media";
  /** Media nodes are retrieval candidates only; they never carry authority. */
  candidate?: boolean;
  mediaKind?: "image" | "document" | "video" | "audio";
  summary?: string;
}

// ---------------------------------------------------------------------------
// Context nodes
// ---------------------------------------------------------------------------

export interface ContextNode extends NodeBase {
  kind: ContextNodeKind;
  contextId: string;
  status: ContextLifecycleStatus;
  authority: AuthorityLevel;
  type: ContextType;
  governanceClassification?: string;
  approvalRequired?: boolean;
  enforcementMode?: "block" | "warn" | "comment" | "silent";
  sourceFormat?: "lcdd-0.6" | "nodenet-legacy";
}

// ---------------------------------------------------------------------------
// Actor nodes (ownership layer)
// ---------------------------------------------------------------------------

export interface TeamNode extends NodeBase {
  kind: "team";
  teamId: string;
}

export interface DeveloperNode extends NodeBase {
  kind: "developer";
  handle: string;
  teamId?: string;
}

export interface RoleNode extends NodeBase {
  kind: "role";
}

export type GraphNode =
  | RepositoryNode
  | WorkspaceNode
  | PackageNode
  | DirectoryNode
  | FileNode
  | FunctionNode
  | MethodNode
  | ClassNode
  | InterfaceNode
  | TypeAliasNode
  | EnumNode
  | VariableNode
  | ReactComponentNode
  | ReactHookNode
  | ApiRouteNode
  | MiddlewareNode
  | TestNode
  | ConfigurationNode
  | ArtifactNode
  | ContextNode
  | TeamNode
  | DeveloperNode
  | RoleNode;

/** Kind of a node instance. */
export function nodeKind(node: GraphNode): NodeKind {
  return node.kind;
}

/** All kinds, used by runtime validation schemas. */
export const ALL_NODE_KINDS = [
  ...CODE_NODE_KINDS,
  ...CONTEXT_NODE_KINDS,
  ...ACTOR_NODE_KINDS,
] as const satisfies readonly NodeKind[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable short label for a node, used across CLI output. */
export function nodeLabel(node: GraphNode): string {
  switch (node.kind) {
    case "repository":
      return `repository:${node.name}`;
    case "workspace":
      return `workspace:${node.name}`;
    case "package":
      return `package:${node.name}`;
    case "directory":
      return `directory:${node.name}`;
    case "file":
      return node.path;
    case "function":
      return `${node.name}() @ ${node.path}:${node.line}`;
    case "method":
      return `${node.name}() @ ${node.path}:${node.line}`;
    case "class":
      return `${node.name} @ ${node.path}:${node.line}`;
    case "interface":
      return `${node.name} @ ${node.path}:${node.line}`;
    case "typeAlias":
      return `${node.name} @ ${node.path}:${node.line}`;
    case "enum":
      return `${node.name} @ ${node.path}:${node.line}`;
    case "variable":
      return `${node.name} @ ${node.path}:${node.line}`;
    case "reactComponent":
      return `<${node.name} /> @ ${node.path}:${node.line}`;
    case "reactHook":
      return `${node.name}() @ ${node.path}:${node.line}`;
    case "apiRoute":
      return `route ${node.name} @ ${node.path}:${node.line}`;
    case "middleware":
      return `middleware @ ${node.path}`;
    case "test":
      return `test ${node.name} @ ${node.path}`;
    case "configuration":
      return `config ${node.name} @ ${node.path}`;
    case "document":
    case "apiOperation":
    case "databaseTable":
    case "infrastructureResource":
      return `${node.kind} ${node.name} @ ${node.path}${node.line ? `:${node.line}` : ""}`;
    case "businessRule":
    case "architectureDecision":
    case "securityPolicy":
    case "codingConvention":
    case "requirement":
    case "specification":
    case "complianceRule":
    case "operationalRule":
    case "incidentLearning":
    case "assumption":
    case "domainRule":
    case "externalConstraint":
      return `context ${node.contextId} (${node.name})`;
    case "team":
      return `team ${node.name}`;
    case "developer":
      return `developer ${node.handle}`;
    case "role":
      return `role ${node.name}`;
  }
}

/** Name (team handle) used for reviewer dedup. */
export function actorName(node: TeamNode | DeveloperNode | RoleNode): string {
  return node.kind === "developer" ? node.handle : node.name;
}
