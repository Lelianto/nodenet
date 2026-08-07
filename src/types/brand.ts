/**
 * Branded types (NodeNet spec §31).
 *
 * Identifiers that could be confused with one another are branded so that,
 * e.g., a `TeamId` can never be passed where a `ContextId` is expected.
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Unique id of a node in the unified graph. */
export type NodeId = Brand<string, "NodeId">;

/** Unique id of an edge in the unified graph. */
export type EdgeId = Brand<string, "EdgeId">;

/** Identifier of a Living Context artifact (LCDD `id`, e.g. `PAYMENT-003`). */
export type ContextId = Brand<string, "ContextId">;

/** Identifier of a team (e.g. `payment-team`). */
export type TeamId = Brand<string, "TeamId">;

/** Identifier of a developer/user handle (e.g. `@alice`). */
export type PersonId = Brand<string, "PersonId">;

/** Identifier of a code symbol within a file (name scoped by file). */
export type SymbolId = Brand<string, "SymbolId">;

export function brand<T, B extends string>(value: T): Brand<T, B> {
  return value as Brand<T, B>;
}
