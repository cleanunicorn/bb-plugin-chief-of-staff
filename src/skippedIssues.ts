// Issues the operator skipped: intake leaves them alone, even after a relabel or reassignment, until they are
// unskipped. Kept in one kv entry (a handful of issues), keyed `owner/repo#N`. Chief of Staff writes nothing to
// GitHub for a skip: the issue keeps its labels and stays open.
import type { Cos } from "./context";

const KEY = "intake:skippedIssues";

export interface SkippedIssue {
  at: string;
  actor: string;
}

export const skippedIssueKey = (repo: string, issueNumber: number) => `${repo}#${issueNumber}`;

/** Every skipped issue, by `owner/repo#N`. */
export async function skippedIssues(cos: Pick<Cos, "bb">): Promise<Record<string, SkippedIssue>> {
  return (await cos.bb.storage.kv.get<Record<string, SkippedIssue>>(KEY)) ?? {};
}

/** Skip or unskip an issue. Returns whether anything changed. */
export async function setIssueSkipped(cos: Pick<Cos, "bb" | "now">, repo: string, issueNumber: number, skipped: boolean, actor: string): Promise<boolean> {
  const all = await skippedIssues(cos);
  const key = skippedIssueKey(repo, issueNumber);
  if (Boolean(all[key]) === skipped) return false;
  if (skipped) all[key] = { at: cos.now().toISOString(), actor };
  else delete all[key];
  await cos.bb.storage.kv.set(KEY, all);
  return true;
}
