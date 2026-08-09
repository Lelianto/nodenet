# Historical decision evaluation

NodeNet Decision Lab measures governance decisions against human labels and
observed GitHub review activity without executing repository code.

## Import and replay

```bash
export GITHUB_TOKEN=github-token
nodenet eval import-github --repo owner/repo --since 2026-01-01 --limit 200 --dataset pilot-q1
nodenet eval run --dataset pilot-q1
```

The importer stores PR metadata, immutable base/head SHAs, requested reviewers,
submitted reviewers, merge state, and numeric author identity under
`.nodenet/evaluation/`. Replay creates an isolated temporary Git worktree for
each head SHA, loads the historical NodeNet/LCDD/CODEOWNERS state, compares it
with the base SHA, records duration and decision, then removes the worktree.
It never installs dependencies or runs repository scripts, tests, hooks, or
binaries.

All referenced commits must be available locally. Fetch missing historical
refs before replay. Evaluation files are ignored by Git by default because
pilot labels and repository metadata may be sensitive.

## Blind labeling UI

```bash
nodenet eval label --dataset pilot-q1 --run <run-id>
```

The local loopback-only Decision Lab opens in a browser. NodeNet's answer is
hidden initially to reduce bias. A label records expected outcome/reviewers,
hardened-impact expectation, correct/false-positive/wrong-reviewer/missed-
impact classification, confidence, notes, and labeler.

The labeler field is a local claimed identity. Organization mode will bind
labels to an authenticated Principal; do not treat local text as verified.

## Report and regression gate

```bash
nodenet eval report --run <run-id> --json
nodenet eval gate --run <run-id> \
  --min-precision .80 --min-recall .75 \
  --max-false-block .05 --max-missed-hardened 0
```

The gate exits with code `2` when thresholds fail. Human labels are the primary
quality reference; observed GitHub reviewers are supporting workflow evidence,
not automatic ground truth.
