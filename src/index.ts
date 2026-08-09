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
export { buildCriticalReview } from "./review/critical.js";
export type { CriticalReview, CriticalReviewDecision, ReviewRisk, RiskPriority } from "./review/critical.js";

export { computeHealth } from "./health/health.js";
export type { HealthReport } from "./health/health.js";

export { buildReport, renderReportMarkdown } from "./report/report.js";
export type {
  GraphReport,
  ReportGodNode,
  ReportConnection,
  ReportCommunity,
  ReportGovernance,
  ReportSuggestedQuestion,
} from "./report/report.js";

export { buildContextBundle } from "./ai/context-builder.js";
export { estimateTokens, DEFAULT_CONTEXT_TOKEN_BUDGET, MIN_CONTEXT_TOKEN_BUDGET, MAX_CONTEXT_TOKEN_BUDGET } from "./ai/context-builder.js";
export type { ContextBundle, ContextBundleMetrics, ContextBundleOptions, BundleContextRef, BundleOwner, BundleGuidance, BundleCodeEvidence } from "./ai/context-builder.js";

export { loadContexts } from "./context/loader.js";
export { transitionContext, applyDecay, canTransition, allTransitions } from "./context/lifecycle.js";
export type { TransitionAuditEvent } from "./context/lifecycle.js";
export * from "./context/schema.js";
export {
  adaptLcddContext,
  authorityFromLcddLevel,
  effectiveEnforcementMode,
  isActiveContext,
  legacyToLcddContext,
} from "./context/lcdd.js";

export { buildOwnershipIndex, readCodeowners, gitHistorySuggestion } from "./ownership/resolver.js";
export type { OwnershipIndex, OwnershipResolution } from "./ownership/resolver.js";
export * from "./ownership/schema.js";

export * from "./authority/authority.js";

export { loadConfig, defaultConfig } from "./config/config.js";
export type { NodeNetConfig, LoadedConfig, Suppression } from "./config/config.js";

export { saveGraph, loadGraph, appendAudit, loadSuppressions, dotNodenetDir } from "./storage/storage.js";
export type { AuditEntry } from "./storage/storage.js";

export { renderGraphHtml } from "./visualization/html.js";
export { startMcpHttpServer, type McpHttpOptions, type McpHttpServer } from "./mcp/http.js";
export { installAgentGuidance, uninstallAgentGuidance, AGENT_PLATFORMS, type AgentPlatform } from "./integration/installer.js";
export { analyzeChangeCollisions, type CollisionReport, type ChangeCollision, type ChangeSetSummary } from "./change/collisions.js";
export { registerLanguageAdapter, registeredLanguageAdapters, languageSupportMatrix, type LanguageAdapter, type LanguageSupportTier, type LanguageCapability } from "./parser/registry.js";
export type { RenderOptions } from "./visualization/html.js";
export { renderGraphSvg } from "./visualization/svg.js";
export type { SvgOptions } from "./visualization/svg.js";
export { detectCommunities } from "./visualization/communities.js";
export type { CommunityId } from "./visualization/communities.js";
export { layoutGraph } from "./visualization/layout.js";
export type { Point, LayoutOptions } from "./visualization/layout.js";
export { startGraphDevServer } from "./visualization/dev-server.js";
export type { GraphDevServer, GraphDevServerOptions } from "./visualization/dev-server.js";
export { resolveGitHubIdentity } from "./identity/identity.js";
export type { IdentityAssurance, VerifiedIdentity } from "./identity/identity.js";
export { authorizeOverride, loadAccessPolicy, NODENET_ROLES } from "./identity/rbac.js";
export type { AccessPolicy, NodeNetRole, RoleBinding } from "./identity/rbac.js";
export { signOverride, verifySignedOverride } from "./identity/signed-override.js";
export type { SignedOverride, SignedOverridePayload } from "./identity/signed-override.js";
export { importGitHubHistory } from "./evaluation/github-import.js";
export { loadDataset, loadEvaluationRun, loadLabels, saveDataset, saveEvaluationRun, saveLabel } from "./evaluation/store.js";
export { replayDataset } from "./evaluation/replay.js";
export { buildEvaluationReport, evaluationGate } from "./evaluation/report.js";
export { startLabelServer } from "./evaluation/label-server.js";
export type { EvaluationDataset, EvaluationLabel, EvaluationRun, EvaluationCaseRun, HistoricalPullRequest, FeedbackClass } from "./evaluation/types.js";

export { safeRelativePath, resolveSafe, readFileSafe } from "./security/filesystem.js";
export type { SafeRelativePath } from "./security/filesystem.js";
export { detectSecrets, containsSecrets, isSecretFilePath } from "./security/secrets.js";

export { runCli } from "./cli/cli.js";

export { analyzePr, runPrIntegration } from "./github/github.js";
export type { PrAnalyzeOptions, PrAnalyzeResult, PrPostOptions, PrPostResult } from "./github/github.js";
export { buildPrComment } from "./github/comment.js";
export type { PrCommentOptions } from "./github/comment.js";
export { isBlockingReview } from "./github/comment.js";

export {
  buildGovernanceDecision,
  isGovernanceMode,
  GOVERNANCE_DECISION_SCHEMA_VERSION,
  GOVERNANCE_MODES,
} from "./governance/decision.js";
export {
  appendDecisionAudit,
  applyDecisionOverride,
  decisionFingerprint,
  isOverrideActive,
  saveOverride,
} from "./governance/audit.js";
export type { DecisionAuditInput, DecisionOverride } from "./governance/audit.js";
export { NODENET_VERSION } from "./version.js";
export { loadBenchmarkCases, scoreBenchmark } from "./evaluation/benchmark.js";
export type { BenchmarkMetrics, LabeledDecisionCase } from "./evaluation/benchmark.js";
export { assessReadiness } from "./onboarding/readiness.js";
export type { ReadinessCheck, ReadinessReport } from "./onboarding/readiness.js";
export { bootstrapRepository } from "./onboarding/bootstrap.js";
export type { BootstrapResult } from "./onboarding/bootstrap.js";
export type {
  GovernanceDecision,
  GovernanceMode,
  GovernanceOutcome,
  ContextEvidence,
  ApprovalRequirement,
} from "./governance/decision.js";
export {
  postIssueComment,
  upsertIssueComment,
  requestReviewers,
  parseRepo,
  resolvePullNumber,
  resolveGitHubToken,
  defaultApiUrl,
  GitHubApiError,
  upsertCheckRun,
} from "./github/client.js";
export type { GitHubClientConfig, GitHubComment, GitHubReviewRequest, GitHubCheckRun } from "./github/client.js";

export { handleMcpLine, prepareMcpContext, MCP_PROTOCOL_VERSION } from "./mcp/server.js";
export type { McpContext, McpTool } from "./mcp/server.js";

export type { AnalysisState } from "./types/analysis-state.js";

export * from "./types/brand.js";
export * from "./types/result.js";
