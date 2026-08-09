/** Local, reversible query-first integration for coding assistants. */
import fs from "node:fs";
import path from "node:path";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";

export const AGENT_PLATFORMS = ["codex", "claude", "cursor", "agents"] as const;
export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

const START = "<!-- nodenet:query-first:start -->";
const END = "<!-- nodenet:query-first:end -->";
const BODY = `${START}
## NodeNet change governance

Before broad source search or a material code change:

1. Run \`nodenet ask "<task or question>"\`, then \`nodenet context "<selected target>" --detail source\` to retrieve minimum sufficient context.
2. Check \`nodenet governed-by <target>\` and \`nodenet owner <target>\`.
3. Before editing, use \`nodenet affected <target>\` for hypothetical blast radius. After editing, run \`nodenet impact\` and \`nodenet reviewers\`.
4. Treat DECLARED governance evidence as authoritative; distinguish EXTRACTED, INFERRED, and AMBIGUOUS evidence.
5. Do not bypass a blocking governance decision. Explain the evidence path when proposing an exception.
${END}`;

function target(platform: AgentPlatform): string {
  switch (platform) {
    case "codex": return "AGENTS.md";
    case "claude": return "CLAUDE.md";
    case "cursor": return path.join(".cursor", "rules", "nodenet.mdc");
    case "agents": return path.join(".agents", "rules", "nodenet.md");
  }
}

export function installAgentGuidance(root: string, platform: AgentPlatform): Result<string, Error> {
  const relative = target(platform);
  const file = path.join(root, relative);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const block = platform === "cursor"
      ? `---\ndescription: Query NodeNet before broad search and govern every material change\nalwaysApply: true\n---\n\n${BODY}`
      : BODY;
    const matcher = new RegExp(`${START}[\\s\\S]*?${END}`);
    const next = matcher.test(existing)
      ? existing.replace(matcher, BODY)
      : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`;
    fs.writeFileSync(file, next, "utf8");
    return ok(relative);
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
}

export function uninstallAgentGuidance(root: string, platform: AgentPlatform): Result<string, Error> {
  const relative = target(platform);
  const file = path.join(root, relative);
  try {
    if (!fs.existsSync(file)) return ok(relative);
    const existing = fs.readFileSync(file, "utf8");
    const matcher = new RegExp(`(?:---[\\s\\S]*?---\\s*)?${START}[\\s\\S]*?${END}\\s*`);
    const next = existing.replace(matcher, "").trim();
    if (next) fs.writeFileSync(file, `${next}\n`, "utf8");
    else fs.unlinkSync(file);
    return ok(relative);
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
}
