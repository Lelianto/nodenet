/**
 * Typed results and domain errors (NodeNet spec §35).
 *
 * Expected failures return `Result<T, E>` instead of relying on exceptions.
 */

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Base class for all NodeNet domain errors. */
export class NodeNetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class GraphBuildError extends NodeNetError {
  constructor(message: string) {
    super("GRAPH_BUILD_ERROR", message);
  }
}

export class InvalidContextError extends NodeNetError {
  constructor(message: string) {
    super("INVALID_CONTEXT", message);
  }
}

export class InvalidTransitionError extends NodeNetError {
  constructor(message: string) {
    super("INVALID_TRANSITION", message);
  }
}

export class ContextConflictError extends NodeNetError {
  constructor(message: string) {
    super("CONTEXT_CONFLICT", message);
  }
}

export class OwnershipResolutionError extends NodeNetError {
  constructor(message: string) {
    super("OWNERSHIP_RESOLUTION", message);
  }
}

export class UnsafePathError extends NodeNetError {
  constructor(message: string) {
    super("UNSAFE_PATH", message);
  }
}

export class MalformedConfigError extends NodeNetError {
  constructor(message: string) {
    super("MALFORMED_CONFIG", message);
  }
}

export class LimitExceededError extends NodeNetError {
  constructor(message: string) {
    super("LIMIT_EXCEEDED", message);
  }
}

export class InvalidEdgeError extends NodeNetError {
  constructor(message: string) {
    super("INVALID_EDGE", message);
  }
}

export class GitError extends NodeNetError {
  constructor(message: string) {
    super("GIT_ERROR", message);
  }
}

/** Human-readable message from an unknown thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/** Exhaustiveness guard (NodeNet spec §36). */
export function assertNever(value: never): never {
  throw new GraphBuildError(`Unhandled case: ${String(value)}`);
}
