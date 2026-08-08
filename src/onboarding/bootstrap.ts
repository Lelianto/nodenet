import fs from "node:fs";
import path from "node:path";

export interface BootstrapResult { created: string[]; skipped: string[] }

function sampleContext(now: string): string { return `id: CHANGE-001
version: 1
created_at: '${now}'
updated_at: '${now}'
title: Critical change approval
description: Critical paths require explicit owner approval.
source:
  type: organization
  location: engineering/change-policy
  extraction_method: manual
  confidence: 1
authority:
  source:
    type: organization
    id: platform-team
    name: Platform Team
  level: 2
  trust_model: direct
  trust_score: 1
category: architecture
severity: high
applies_to:
  - src/**
lifecycle: active
governance:
  classification: local-standard
  approval_required: true
  approvers:
    - platform-team
effective_date: '${now}'
owner: platform-team
review_status: approved
enforcement:
  mode: warn
tags:
  - change-governance
`; }

const WORKFLOW = `name: NodeNet Governance
on:
  pull_request:
  merge_group:
permissions:
  contents: read
  checks: write
  pull-requests: write
jobs:
  governance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci --ignore-scripts
      - run: npx @antihero/nodenet build --json
      - name: Enforce governance
        env:
          GITHUB_PR_NUMBER: \${{ github.event.pull_request.number }}
        run: npx @antihero/nodenet github pr --repo "$GITHUB_REPOSITORY" --base "origin/\${GITHUB_BASE_REF:-main}" --mode enforce --check --sha "$GITHUB_SHA" --json
`;

export function bootstrapRepository(root: string, github = false): BootstrapResult {
  const result: BootstrapResult = { created: [], skipped: [] };
  writeIfMissing(root, "nodenet.config.json", JSON.stringify({
    reviewPolicy: { LOW: "informational", MEDIUM: "comment", HIGH: "request", CRITICAL: "approval" },
    ownership: { teams: {}, overrides: [] },
  }, null, 2) + "\n", result);
  writeIfMissing(root, ".lcdd/contexts/CHANGE-001.yaml", sampleContext(new Date().toISOString()), result);
  if (github) writeIfMissing(root, ".github/workflows/nodenet-governance.yml", WORKFLOW, result);
  return result;
}

function writeIfMissing(root: string, relative: string, content: string, result: BootstrapResult): void {
  const file = path.join(root, relative);
  if (fs.existsSync(file)) { result.skipped.push(relative); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { flag: "wx" });
  result.created.push(relative);
}
