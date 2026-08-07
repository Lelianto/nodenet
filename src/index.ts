/**
 * NodeNet public API (spec §55).
 *
 * Strongly typed, no global mutable singleton — multiple graphs can exist
 * within one process. Every function takes its inputs explicitly.
 */

export { Graph, emptyPatch, mergePatches } from "./graph/graph.js";
export type { GraphPatch, GraphMetadata, GraphSnapshot, GraphLimits } from "./graph/graph.js";
export { collectAffected, findPath, neighbors } from "./graph/traversal.js";
export type { TraversalLimits, TraversalResult } from "./graph/traversal.js";
export * from "./graph/nodes.js";
export * from "./graph/edges.js";

export { buildCodeGraph, makeNodeId, makeEdgeId } from "./analyzer/code-graph.js";
export type { CodeGraphIndex, CodeBuildResult } from "./analyzer/code-graph.js";
export { attachGovernanceLayers } from "./analyzer/governance.js";
export type { GovernanceResult } from "./analyzer/governance.js";

export { analyzeImpact } from "./change/impact.js";
export type { ImpactReport, ImpactOptions, SymbolChange, BoundaryCrossing, AffectedOwner } from "./change/impact.js";
export { gitDiffChanges, parseUnifiedDiff, isValidRef } from "./change/diff.js";
export type { ChangedHunk } from "./change/diff.js";

export { resolveReviewers } from "./review/resolver.js";
export type { ReviewResolution, Reviewer } from "./review/resolver.js";
export { computeSeverity } from "./review/severity.js";
export type { Severity, SeverityInput } from "./review/severity.js";

export { computeHealth } from "./health/health.js";
export type { HealthReport } from "./health/health.js";

export { buildContextBundle } from "./ai/context-builder.js";
export type { ContextBundle, BundleContextRef, BundleOwner, BundleGuidance } from "./ai/context-builder.js";

export { loadContexts } from "./context/loader.js";
export { transitionContext, applyDecay, canTransition, allTransitions } from "./context/lifecycle.js";
export type { TransitionAuditEvent } from "./context/lifecycle.js";
export * from "./context/schema.js";

export { buildOwnershipIndex, readCodeowners, gitHistorySuggestion } from "./ownership/resolver.js";
export type { OwnershipIndex, OwnershipResolution } from "./ownership/resolver.js";
export * from "./ownership/schema.js";

export * from "./authority/authority.js";

export { loadConfig, defaultConfig } from "./config/config.js";
export type { NodeNetConfig, LoadedConfig, Suppression } from "./config/config.js";

export { saveGraph, loadGraph, appendAudit, loadSuppressions, dotNodenetDir } from "./storage/storage.js";
export type { AuditEntry } from "./storage/storage.js";

export { renderGraphHtml } from "./visualization/html.js";

export { safeRelativePath, resolveSafe, readFileSafe } from "./security/filesystem.js";
export type { SafeRelativePath } from "./security/filesystem.js";
export { detectSecrets, containsSecrets, isSecretFilePath } from "./security/secrets.js";

export { runCli } from "./cli/cli.js";

export * from "./types/brand.js";
export * from "./types/result.js";
