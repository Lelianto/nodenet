/**
 * Secret protection (NodeNet spec §45).
 *
 * NodeNet never collects secret-like files by default, and generated AI
 * context is scanned for obvious secrets before output.
 */

/** Default file patterns never scanned. */
export const DEFAULT_SECRET_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "credentials.*",
  "secrets.*",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  ".pypirc",
];

export const SECRET_PATTERNS: RegExp[] = [
  /\b(?:AKIA|AGPA|ASIA)[A-Z0-9]{16}\b/, // AWS access key id
  /ghp_[A-Za-z0-9]{36,}/, // GitHub personal access token
  /github_pat_[A-Za-z0-9_]{22,}/,
  /sk-(?:live|test)-[A-Za-z0-9]{16,}/, // Stripe keys
  /sk-proj-[A-Za-z0-9]{16,}/, // OpenAI project keys
  /sk-[A-Za-z0-9]{20,}/, // OpenAI-style keys
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, // private key blocks
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /AIza[0-9A-Za-z_-]{35}/, // Google API keys
];

/** True when a file path matches default secret patterns. */
export function isSecretFilePath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return DEFAULT_SECRET_PATTERNS.some((pat) => {
    if (pat.includes("*")) {
      const re = new RegExp(
        "^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      );
      return re.test(lower) || re.test(lower.split("/").at(-1) ?? "");
    }
    return lower.endsWith(pat) || lower.includes(pat);
  });
}

/**
 * Scan text for obvious secrets. Returns the list of matched descriptions
 * (never the secret values themselves).
 */
export function detectSecrets(text: string): string[] {
  const found: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      found.push(`matched ${pattern.source}`);
    }
  }
  return found;
}

/** True when generated context should be flagged before output. */
export function containsSecrets(text: string): boolean {
  return detectSecrets(text).length > 0;
}
