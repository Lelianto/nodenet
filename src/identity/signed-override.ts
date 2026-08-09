import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export interface SignedOverridePayload {
  schemaVersion: "1";
  overrideId: string;
  decisionId: string;
  commitSha: string;
  repository: string;
  actorGithubId: number;
  reason: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  keyId: string;
}
export interface SignedOverride { payload: SignedOverridePayload; signature: string }

function canonical(payload: SignedOverridePayload): Buffer {
  const ordered = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)));
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

export function signOverride(payload: SignedOverridePayload, privateKeyPem: string): SignedOverride {
  const signature = sign(null, canonical(payload), createPrivateKey(privateKeyPem)).toString("base64url");
  return { payload, signature };
}

export function verifySignedOverride(
  signed: SignedOverride,
  publicKeyPem: string,
  expected: { decisionId: string; commitSha: string; repository: string },
  now = new Date(),
): { valid: boolean; reason: string } {
  const payload = signed.payload;
  if (payload.decisionId !== expected.decisionId || payload.commitSha !== expected.commitSha || payload.repository !== expected.repository) return { valid: false, reason: "signed override scope does not match decision, commit, or repository" };
  if (new Date(payload.expiresAt).getTime() <= now.getTime()) return { valid: false, reason: "signed override has expired" };
  const valid = verify(null, canonical(payload), createPublicKey(publicKeyPem), Buffer.from(signed.signature, "base64url"));
  return valid ? { valid: true, reason: "signature and scope are valid" } : { valid: false, reason: "signature is invalid" };
}
