# Verified identity and overrides

An offline `--override-actor` value is a claim, not proof of identity. NodeNet
records it with `identityAssurance: claimed`. In GitHub Actions, NodeNet derives
the actor's immutable numeric GitHub ID and login from the runner identity
context; with a user token it verifies identity through GitHub's `/user` API.

Authenticated overrides are default-deny and require a local access policy:

```json
{
  "schemaVersion": "1",
  "bindings": [
    {
      "githubUserId": 12345678,
      "role": "override-approver",
      "repositories": ["acme/payments"],
      "contextPatterns": ["SEC-*", "PAYMENT-*"]
    }
  ]
}
```

Save it as `.nodenet/access.json` and review it like other governance policy.
GitHub login names are display values; authorization keys use numeric IDs.
Bindings can be repository- and Context-scoped and optionally expire.

The public API also provides Ed25519 `signOverride` and
`verifySignedOverride`. A signed payload binds an override to its decision ID,
commit SHA, repository, numeric GitHub actor, reason, issue/expiry time, nonce,
and key ID. Production callers must additionally persist nonce/revocation state
and protect private keys in a secret manager or customer-managed key service.

This release provides the local verifier and policy foundation. Organization
membership synchronization, hosted approval screens, webhook processing, key
rotation service, immutable remote audit storage, and a full GitHub App remain
deployment-stage work after design-partner validation.
