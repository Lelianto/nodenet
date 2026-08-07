# The NodeNet Graph

NodeNet is one coherent graph with several layers (spec §3):

```
CODE GRAPH + CONTEXT GRAPH + OWNERSHIP GRAPH + AUTHORITY GRAPH + CHANGE GRAPH
                               ↓
                          UNIFIED GRAPH
```

## Nodes

Every node has a literal `kind` (spec §32) and a branded `id`. Kinds:

- **Code**: `repository workspace package directory file function method class
  interface typeAlias enum variable reactComponent reactHook apiRoute
  middleware test configuration`
- **Context**: `businessRule architectureDecision securityPolicy
  codingConvention requirement specification complianceRule operationalRule
  incidentLearning assumption domainRule externalConstraint`
- **Actors**: `developer team role`

## Edges

Every edge has a relation and a provenance block (`source`, `location`), so
every relationship is explainable (spec §4). Invalid relation/kind combinations
are rejected at construction via `RELATION_RULES` (spec §33).

- **Code**: `contains imports exports reexports calls references uses
  implements extends renders tests configures depends_on`
- **Context**: `governed_by constrained_by implements_context validated_by
  supersedes conflicts_with derived_from applies_to`
- **Ownership**: `owned_by approved_by maintains reviews member_of
  responsible_for`
- **Change**: `affects modifies` (ephemeral)

## Operations

- `nodenet query <name>` — name search
- `nodenet related <name>` — direct neighbors
- `nodenet trace <a> <b>` — shortest explainable path
- `nodenet explain <name>` — a node and every relationship with provenance

All traversal is cycle-safe with visited sets, max depth and max node counts
(spec §41).

## See also

- How a change traverses the graph → [change-impact.md](change-impact.md)
- How reviewers are derived from graph reachability → [review-governance.md](review-governance.md)
- How the graph is built and persisted → [../../ARCHITECTURE.md](../../ARCHITECTURE.md)
- Why the graph is stored as local JSON → [../adr/003-graph-storage.md](../adr/003-graph-storage.md)
