/** Deterministic, no-LLM extraction for governance-relevant repository artifacts. */
import fs from "node:fs";
import path from "node:path";
import type { Graph } from "../graph/graph.js";
import type { ArtifactNode } from "../graph/nodes.js";
import type { ScanEntry } from "../scanner/scanner.js";
import { makeEdgeId, makeNodeId } from "./code-graph.js";

export interface ArtifactStats { documents: number; apiOperations: number; databaseTables: number; infrastructureResources: number }

export function attachRepositoryArtifacts(graph: Graph, entries: ScanEntry[]): ArtifactStats {
  const stats: ArtifactStats = { documents: 0, apiOperations: 0, databaseTables: 0, infrastructureResources: 0 };
  for (const entry of entries) {
    const rel = entry.relPath.toString();
    if (!/\.(md|ya?ml|json|sql|tf)$/i.test(rel)) continue;
    let content: string;
    try { content = fs.readFileSync(entry.absPath, "utf8"); } catch { continue; }
    if (/\.md$/i.test(rel) && /(^|\/)(adr|rfcs?|docs)(\/|$)/i.test(rel)) {
      const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(rel);
      addArtifact(graph, { kind: "document", id: makeNodeId("artifact", "document", rel), name: title, path: entry.relPath, artifactType: "adr" });
      stats.documents++;
    }
    if (/(openapi|swagger)/i.test(rel) || /["']?openapi["']?\s*[:=]/i.test(content)) {
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

function addArtifact(graph: Graph, node: ArtifactNode): ArtifactNode { graph.addNode(node); return node; }
function link(graph: Graph, from: ArtifactNode["id"], to: ArtifactNode["id"], relation: "defines", location: string): void {
  graph.addEdge({ id: makeEdgeId(from, relation, to), from, to, relation, provenance: { source: "config", classification: "EXTRACTED", location } });
}
