# NodeNet glossary

Plain-language definitions for terms used by NodeNet and LCDD.

| Term | Plain-language meaning |
| --- | --- |
| **Activation** | The steps that make a repository ready for NodeNet: configuration, Context, ownership, graph build, and optional GitHub workflow. |
| **Actor** | The person or system performing an action. A claimed actor is typed by the caller; a verified actor is confirmed by an identity provider such as GitHub. |
| **Annotation** | A message attached by a GitHub Check to a specific file or line. |
| **Approval workflow** | The controlled sequence for requesting, granting, rejecting, expiring, or revoking permission for a governed change. |
| **Audit trail** | A chronological record of decisions and exceptions: what happened, when, why, and who was responsible. |
| **Authority** | The level or source of power a rule or person has to require approval or block a change. |
| **Benchmark** | A repeatable set of labeled examples used to measure whether NodeNet decisions are accurate and fast. |
| **Block** | A decision that says the change must not merge until its required governance conditions are satisfied. It fails CI only in enforce mode. |
| **Change impact** | Code, rules, owners, systems, or teams that may be affected by a change. |
| **Check Run** | A GitHub status attached to a commit, such as NodeNet Governance: success, neutral, or failure. |
| **CODEOWNERS** | A GitHub file that maps repository paths to people or teams responsible for reviewing them. |
| **Context** | A versioned LCDD artifact containing a rule, decision, constraint, owner, scope, authority, lifecycle, and enforcement behavior. It is more than general documentation. |
| **Decision ID** | A deterministic identifier for one exact NodeNet decision. If relevant decision inputs change, the ID changes. |
| **Design partner** | An early customer who uses the product in real work, provides structured feedback, and helps validate value before broad commercialization. |
| **Deterministic** | The same valid input and configuration produce the same result; the answer is not based on random model output. |
| **Enforce mode** | Rollout mode in which a blocking decision makes CI fail and can prevent merge. |
| **Evidence path** | The explainable chain from a changed file or symbol to an affected dependency, governing Context, authority, and required approval. |
| **False block / false positive** | NodeNet blocks or flags a change that should have been allowed. |
| **Governance** | The rules defining what may change, who owns it, who must approve it, and how exceptions are handled. |
| **Graph** | NodeNet's connected model of code, dependencies, Contexts, owners, authorities, and evidence. |
| **Hardened Context** | A high-authority Context intended to protect a critical rule. Changes in its scope normally require explicit approval and may be blocked. |
| **Historical replay** | Running NodeNet against the exact base/head commits and governance files from an older pull request. |
| **Hot reload** | Automatically updating an open visualization after repository files change, without a manual browser refresh. |
| **Idempotent** | Safe to repeat without creating duplicate checks/comments or changing the final meaning. |
| **LCDD** | Living Context Driven Development: treating important development context as living, versioned, governed artifacts. |
| **Label / ground-truth label** | A human-reviewed expected answer used to evaluate NodeNet, such as the correct outcome and reviewers. |
| **Merge queue / `merge_group`** | GitHub's mechanism for testing a temporary group of changes before they enter the target branch. |
| **Missed impact / false negative** | A relevant risk, Context, dependency, or reviewer that NodeNet failed to detect. |
| **Observe mode** | NodeNet records what it would decide but does not disrupt the existing workflow. |
| **Override** | A time-bounded, reasoned exception allowing a blocked change to proceed without erasing the original decision. |
| **p50 / median latency** | Half of analyses are faster than this duration and half are slower. |
| **p95 latency** | Ninety-five percent of analyses complete within this duration; it reveals the slower tail. |
| **Paid pilot** | A limited customer deployment with agreed scope, success metrics, duration, and payment. |
| **Precision** | Of the reviewers or risks NodeNet predicted, the fraction that humans confirmed as correct. High precision means fewer unnecessary alerts. |
| **Pull request (PR)** | A proposed set of repository changes submitted for review before merging. |
| **RBAC** | Role-Based Access Control: permissions granted through roles such as Viewer, Context Owner, or Security Approver. |
| **Recall** | Of all reviewers or risks that should have been found, the fraction NodeNet found. High recall means fewer misses. |
| **Reviewer routing** | Selecting and requesting the people or teams whose ownership or authority makes their review necessary. |
| **Shadow comparison** | Comparing NodeNet decisions with human workflow while NodeNet remains non-blocking. |
| **Signed override** | An override cryptographically bound to a decision, commit, repository, verified approver, reason, and expiry so tampering can be detected. |
| **Source-free metadata** | Decision facts such as IDs, file paths, outcomes, and versions that exclude repository source contents. |
| **Warn mode** | NodeNet reports risk and reviewers but does not fail CI. |

## Reading a decision in plain language

```text
BLOCK · CRITICAL · security-team required
```

means:

> This change reaches a critical governed area. It should not merge until the
> security team provides the approval required by the applicable Context.

The detailed evidence path should explain exactly how NodeNet reached that
conclusion.
