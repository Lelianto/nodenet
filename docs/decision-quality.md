# Decision quality and auditability

NodeNet treats governance accuracy as a release gate. A labeled dataset is a
JSON array containing expected and actual outcome/reviewer fields plus measured
latency. Run it locally or in CI:

```bash
nodenet benchmark --dataset examples/decision-benchmark.json
nodenet benchmark --dataset examples/decision-benchmark.json --json
```

The report includes reviewer precision and recall, false-block rate,
missed-hardened-impact rate, outcome accuracy, and p50/p95 latency. Real pilot
datasets should be reviewed by code owners and security/platform authorities;
the bundled dataset only demonstrates the format.

Every `github pr` evaluation appends a source-free event to
`.nodenet/audit.jsonl`. The event includes a deterministic `decisionId`, engine
version, LCDD version, rollout mode, outcome, counts, repository/PR identity,
and override metadata. It does not contain source code or tokens.

## Emergency override

First run the analysis with `--json` and copy its `decisionId`. Then run the
same deterministic analysis with a bounded override:

```bash
nodenet github pr --repo acme/payments --pr 42 --base origin/main \
  --mode enforce --override-decision 9de0... \
  --override-actor security-lead \
  --override-reason "Approved emergency remediation" \
  --override-expires 2026-08-09T12:00:00Z --json
```

All four override fields are required. The identifier must match the current
decision and the expiry must be in the future. Overrides clear the process
failure but do not erase the original blocking outcome. Records are appended
to `.nodenet/overrides.jsonl` and the audit log.
