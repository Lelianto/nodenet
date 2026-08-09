/** Local opt-in retrieval outcome feedback. It never mutates graph authority or ranking. */
import fs from "node:fs";
import path from "node:path";

export const RETRIEVAL_OUTCOMES = ["useful", "dead-end", "corrected"] as const;
export type RetrievalOutcome = (typeof RETRIEVAL_OUTCOMES)[number];

export interface RetrievalFeedback {
  queryId: string;
  outcome: RetrievalOutcome;
  at: string;
  note?: string;
}

export function appendRetrievalFeedback(root: string, input: Omit<RetrievalFeedback, "at">): RetrievalFeedback {
  if (!RETRIEVAL_OUTCOMES.includes(input.outcome)) throw new Error(`Invalid retrieval outcome: ${input.outcome}`);
  if (!/^[a-f0-9]{12,64}$/i.test(input.queryId)) throw new Error("queryId must be a 12-64 character hexadecimal identifier.");
  const record: RetrievalFeedback = { ...input, at: new Date().toISOString() };
  const directory = path.join(root, ".nodenet");
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(path.join(directory, "retrieval-feedback.jsonl"), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return record;
}
