/** Deterministic, no-LLM extraction for governance-relevant repository artifacts. */
import fs from "node:fs";
import path from "node:path";
import type { Graph } from "../graph/graph.js";
import type { ArtifactNode } from "../graph/nodes.js";
import type { ScanEntry } from "../scanner/scanner.js";
import { makeEdgeId, makeNodeId } from "./code-graph.js";

export interface ArtifactStats { documents: number; apiOperations: number; databaseTables: number; infrastructureResources: number; mediaAssets: number; mediaConcepts: number }

const MEDIA_EXTENSION = /\.(pdf|png|jpe?g|webp|gif|svg|mp4|mov|mp3|wav|m4a)$/i;
const MAX_MEDIA_SIDECAR_BYTES = 64 * 1024;

export function attachRepositoryArtifacts(graph: Graph, entries: ScanEntry[]): ArtifactStats {
  const stats: ArtifactStats = { documents: 0, apiOperations: 0, databaseTables: 0, infrastructureResources: 0, mediaAssets: 0, mediaConcepts: 0 };
  for (const entry of entries) {
    const rel = entry.relPath.toString();
    if (MEDIA_EXTENSION.test(rel)) {
      attachMediaArtifact(graph, entry, stats);
      continue;
    }
    if (!/\.(md|ya?ml|json|sql|tf)$/i.test(rel)) continue;
    let content: string;
    try { content = fs.readFileSync(entry.absPath, "utf8"); } catch { continue; }
    if (/\.md$/i.test(rel)) {
      // Every Markdown file becomes a deterministic document node: ADR/RFC/docs
      // directories keep the governance-oriented "adr" label, all other
      // Markdown (README, guides, design notes, …) is tagged "markdown".
      const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(rel);
      addArtifact(graph, {
        kind: "document", id: makeNodeId("artifact", "document", rel), name: title, path: entry.relPath,
        artifactType: /(^|\/)(adr|rfcs?|docs)(\/|$)/i.test(rel) ? "adr" : "markdown",
      });
      stats.documents++;
    }
    // Markdown files are already ingested by the document branch above; an
    // `openapi:` snippet inside a README/guide must not spawn a duplicate node.
    if (!/\.md$/i.test(rel) && (/(openapi|swagger)/i.test(rel) || /["']?openapi["']?\s*[:=]/i.test(content))) {
      const parent = addArtifact(graph, { kind: "document", id: makeNodeId("artifact", "openapi", rel), name: path.basename(rel), path: entry.relPath, artifactType: "openapi" });
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        const match = line.match(/^\s{2,}(get|post|put|patch|delete):\s*$/i);
        if (!match) return;
        const route = [...lines.slice(0, index)].reverse().find((candidate) => /^\s{0,4}\/[^:]+:\s*$/.test(candidate))?.trim().replace(/:$/, "") ?? "unknown";
        const node = addArtifact(graph, { kind: "apiOperation", id: makeNodeId("artifact", "api", rel, String(index + 1)), name: `${match[1]?.toUpperCase()} ${route}`, path: entry.relPath, line: index + 1, artifactType: "openapi" });
        link(graph, parent.id, node.id, "defines", rel); stats.apiOperations++;
      });
    }
    if (/\.sql$/i.test(rel)) {
      for (const match of content.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([\w.]+)["`]?/gi)) {
        addArtifact(graph, { kind: "databaseTable", id: makeNodeId("artifact", "table", match[1] ?? "unknown"), name: match[1] ?? "unknown", path: entry.relPath, artifactType: "sql" }); stats.databaseTables++;
      }
    }
    if (/\.tf$/i.test(rel)) {
      for (const match of content.matchAll(/\bresource\s+"([^"]+)"\s+"([^"]+)"/g)) {
        addArtifact(graph, { kind: "infrastructureResource", id: makeNodeId("artifact", "terraform", rel, match[1] ?? "resource", match[2] ?? "unknown"), name: `${match[1]}.${match[2]}`, path: entry.relPath, artifactType: "terraform" }); stats.infrastructureResources++;
      }
    }
  }
  return stats;
}

function attachMediaArtifact(graph: Graph, entry: ScanEntry, stats: ArtifactStats): void {
  const rel = entry.relPath.toString();
  const ext = path.extname(rel).toLowerCase();
  const mediaKind = mediaKindFor(ext);
  const sidecar = readMediaSidecar(`${entry.absPath}.nodenet.json`);
  const parent = addArtifact(graph, {
    kind: "document", id: makeNodeId("artifact", "media", rel), name: path.basename(rel), path: entry.relPath,
    artifactType: "media", candidate: true, mediaKind, ...(sidecar.summary ? { summary: sidecar.summary } : {}),
  });
  stats.mediaAssets++;
  for (const [index, concept] of sidecar.concepts.entries()) {
    const node = addArtifact(graph, {
      kind: "document", id: makeNodeId("artifact", "media-concept", rel, String(index)), name: concept,
      path: entry.relPath, artifactType: "media", candidate: true, mediaKind,
    });
    graph.addEdge({
      id: makeEdgeId(parent.id, "documents", node.id), from: parent.id, to: node.id, relation: "documents",
      provenance: { source: "inferred", classification: "INFERRED", location: `${rel}.nodenet.json` },
    });
    stats.mediaConcepts++;
  }
}

function mediaKindFor(ext: string): NonNullable<ArtifactNode["mediaKind"]> {
  if ([".mp4", ".mov"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".m4a"].includes(ext)) return "audio";
  if (ext === ".pdf") return "document";
  return "image";
}

function readMediaSidecar(filename: string): { summary?: string; concepts: string[] } {
  try {
    const stat = fs.statSync(filename);
    if (stat.size > MAX_MEDIA_SIDECAR_BYTES) return { concepts: [] };
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, unknown>;
    const summary = typeof value["summary"] === "string" ? value["summary"].slice(0, 2_000) : undefined;
    const concepts = Array.isArray(value["concepts"])
      ? value["concepts"].filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 200)).filter(Boolean).slice(0, 50)
      : [];
    return { ...(summary ? { summary } : {}), concepts };
  } catch { return { concepts: [] }; }
}

function addArtifact(graph: Graph, node: ArtifactNode): ArtifactNode { graph.addNode(node); return node; }
function link(graph: Graph, from: ArtifactNode["id"], to: ArtifactNode["id"], relation: "defines", location: string): void {
  graph.addEdge({ id: makeEdgeId(from, relation, to), from, to, relation, provenance: { source: "config", classification: "EXTRACTED", location } });
}
