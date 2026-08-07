# ADR 006: Interactive visualization

- Status: accepted
- Date: 2026-08-07

## Context

Phase 8 (spec §53) requires a richer visualization. Candidates: a JS graph
library (d3-force, vis-network, cytoscape) vendored into the HTML, or a
hand-rolled canvas viewer with our own deterministic layout.

## Decision

Keep the self-contained single HTML file, but replace the plain lists with an
**interactive canvas viewer**:

- **Layout is computed at build time** in TypeScript
  (`src/visualization/layout.ts`) — a community-hierarchical force layout that
  is fully deterministic, so two builds of the same graph produce identical
  coordinates. `O(n²)` work is bounded to per-community sizes.
- **Communities** are detected with deterministic label propagation
  (`src/visualization/communities.ts`) and drawn as translucent hulls.
- The page renders with vanilla Canvas 2D and embeds the layout + edge data as
  JSON. Interactions: pan, zoom, hover-neighbor highlighting, click to inspect
  a node, drag a node, search, and per-layer visibility toggles.
- The exact edge table is kept below the canvas for explainability.

## Rationale

| Criterion | Hand-rolled | vendored library |
| --- | --- | --- |
| New runtime deps | **0** | bundles a library |
| Deterministic layout (spec: reproducibility) | ✅ built in | d3-force is non-deterministic by default |
| Offline / no network | ✅ | ✅ (vendored) |
| Bundle size | small | larger |
| Control over look/UX | full | constrained |

The project's "lightweight, deterministic, explainable" principles (spec §1)
are preserved: layout is reproducible, nothing external is fetched, and the
raw edge table remains for exact reference.

## Security

- The page is static and never executes repository code.
- Embedded JSON is escaped (`</` → `\u003c`) so node labels cannot inject
  markup/scripts.
- Node labels in the canvas/detail panel are HTML-escaped.

## Consequences

- `renderGraphHtml(graph, options)` now accepts layout options
  (`width`, `height`, `iterations`).
- New layout/community algorithms are pure and unit-tested for determinism
  and bounds.
- Very large graphs raise layout cost; per-community bounds keep it
  manageable, and the exact table is capped at 2000 rows.
