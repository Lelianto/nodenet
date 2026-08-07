/**
 * Minimal deterministic glob matcher.
 *
 * Supports `*` (within a segment), `**` (across segments) and `?`.
 * Used for ownership patterns, context `appliesTo` patterns, ignore
 * patterns, and tsconfig include globs. Kept dependency-free and
 * deterministic.
 */

function segmentsToRegex(segments: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? "";
    if (seg === "**") {
      out.push("(?:.*)");
    } else {
      out.push(seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"));
    }
  }
  return `^${out.join("/")}$`;
}

/**
 * Match a normalized POSIX path against a glob pattern.
 * Patterns are normalized to forward slashes. `a/**` also matches `a`.
 */
export function matchGlob(pattern: string, path: string): boolean {
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const pathNorm = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const negate = p.startsWith("!");
  const body = negate ? p.slice(1) : p;

  const re = new RegExp(segmentsToRegex(body.split("/")));
  const match = re.test(pathNorm);
  return negate ? !match : match;
}

/** True when any pattern matches the path. */
export function matchesAny(patterns: string[], path: string): boolean {
  return patterns.some((pat) => matchGlob(pat, path));
}
