// A pull request's own state (open, draft, merged, closed), checks and review,
// as recorded by the sweep (see src/prState.ts), and the Pull requests list on
// the Repos & PRs tab. Every state has its own text and its own host icon;
// colour only supplements them.
import { useState } from "react";
import type { ReactNode } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { relative, toneColor, usePalette, type Tone } from "@/components/cos/viz";
import type { PrState } from "../../src/state";

/** A roster entry's PR state: null when it has not been read yet. */
export type PrInfo = Omit<PrState, "number"> | null;

interface Chip {
  label: string;
  icon: string;
  tone: Tone;
}

export type PrStateKey = "open" | "draft" | "merged" | "closed" | "unknown";

/** Icons are checked against the host catalog in tests/icon.test.ts. */
export const PR_STATE_META: Record<PrStateKey, Chip> = {
  open: { label: "Open", icon: "GitPullRequest", tone: "info" },
  draft: { label: "Draft", icon: "GitPullRequestDraft", tone: "neutral" },
  merged: { label: "Merged", icon: "GitMerge", tone: "good" },
  closed: { label: "Closed", icon: "GitPullRequestClosed", tone: "critical" },
  unknown: { label: "State unknown", icon: "CircleQuestion", tone: "neutral" },
};

export const CHECKS_META: Record<NonNullable<PrState["checks"]>, Chip> = {
  passing: { label: "Checks passing", icon: "CircleCheck", tone: "good" },
  failing: { label: "Checks failing", icon: "CircleX", tone: "critical" },
  pending: { label: "Checks pending", icon: "Clock", tone: "warning" },
  none: { label: "No checks", icon: "Minus", tone: "neutral" },
};

export const REVIEW_META: Record<NonNullable<PrState["review"]>, Chip> = {
  approved: { label: "Approved", icon: "Check", tone: "good" },
  changes_requested: { label: "Changes requested", icon: "EditFile", tone: "serious" },
};

export function prStateKey(pr: PrInfo): PrStateKey {
  if (!pr) return "unknown";
  if (pr.state !== "open") return pr.state;
  return pr.draft ? "draft" : "open";
}

/** The chips a PR shows: its state, then, while open, its checks and review once read. */
function prChips(pr: PrInfo, compact: boolean): Chip[] {
  const chips = [PR_STATE_META[prStateKey(pr)]];
  if (compact || pr?.state !== "open") return chips;
  if (pr.checks) chips.push(CHECKS_META[pr.checks]);
  if (pr.review) chips.push(REVIEW_META[pr.review]);
  return chips;
}

/** "Pull request open, checks failing, changes requested". */
export function prSummary(pr: PrInfo): string {
  const [state, ...rest] = prChips(pr, false).map((c) => c.label.toLowerCase());
  return [`Pull request ${state}`, ...rest].join(", ");
}

function PrChip({ chip }: { chip: Chip }) {
  const palette = usePalette();
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground">
      <Icon name={chip.icon} fallback="Circle" className="size-3.5 shrink-0" style={{ color: toneColor(chip.tone, palette) }} aria-hidden />
      {chip.label}
    </span>
  );
}

/** The PR's state with its checks and review; `compact` shows the state alone. */
export function PrStatePill({ pr, compact = false }: { pr: PrInfo; compact?: boolean }) {
  return (
    <span role="group" data-pr-state={prStateKey(pr)} aria-label={compact ? `Pull request ${PR_STATE_META[prStateKey(pr)].label.toLowerCase()}` : prSummary(pr)} className="inline-flex flex-wrap items-center gap-1">
      {prChips(pr, compact).map((chip) => <PrChip key={chip.label} chip={chip} />)}
    </span>
  );
}

// ---------- the Pull requests list ----------

export type PrFilter = "needs" | "merged" | "closed" | "all";

/** Open, draft and not yet read PRs may still need a review or a merge. */
export function prFilterOf(pr: PrInfo): Exclude<PrFilter, "all"> {
  return !pr || pr.state === "open" ? "needs" : pr.state;
}

/** Failing checks or requested changes: the PRs to look at first. */
function needsAttention(pr: PrInfo): boolean {
  return pr?.state === "open" && (pr.checks === "failing" || pr.review === "changes_requested");
}

const FILTERS: { key: PrFilter; label: string; icon: string; empty: string }[] = [
  { key: "needs", label: "Needs action", icon: "GitPullRequest", empty: "open" },
  { key: "merged", label: "Merged", icon: "GitMerge", empty: "merged" },
  { key: "closed", label: "Closed", icon: "GitPullRequestClosed", empty: "closed" },
  { key: "all", label: "All", icon: "LayoutGrid", empty: "" },
];

/** Rows shown per page: about 570 px of rows, within a screen. */
export const PR_PAGE = 10;

/** What a Pull requests row needs from a roster entry. */
export interface PrListEntry {
  id: string;
  detail: string;
  repo: string;
  issueNumber: number | null;
  issueUrl: string | null;
  issueTitle: string;
  prNumber: number | null;
  prUrl: string | null;
  fixAttempts: number;
  startedAt: string;
  lastActivityAt: string | null;
  pr: PrInfo;
}

const isFinished = (e: PrListEntry) => e.detail === "done" || e.detail === "failed";
const activityAt = (e: PrListEntry) => Date.parse(e.lastActivityAt ?? e.startedAt) || 0;

/**
 * Tasks with a PR, defaulting to the PRs that need action, newest first with
 * failing checks and requested changes ahead, ten at a time. An active task's
 * stage (`stage`) follows its PR's state.
 */
export function PullRequestList<E extends PrListEntry>({ entries, now, authOk, stage, action, empty }: { entries: E[]; now: number; authOk: boolean; stage: (entry: E) => ReactNode; action?: (entry: E) => ReactNode; empty: ReactNode }) {
  const [filter, setFilter] = useState<PrFilter>("needs");
  const [shown, setShown] = useState(PR_PAGE);
  if (!entries.length) return <>{empty}</>;
  const choose = (next: PrFilter) => {
    setFilter(next);
    setShown(PR_PAGE);
  };
  const count = (key: PrFilter) => (key === "all" ? entries.length : entries.filter((e) => prFilterOf(e.pr) === key).length);
  const rows = entries
    .filter((e) => filter === "all" || prFilterOf(e.pr) === filter)
    .sort((a, b) => Number(needsAttention(b.pr)) - Number(needsAttention(a.pr)) || activityAt(b) - activityAt(a));
  const current = FILTERS.find((f) => f.key === filter)!;
  const merged = count("merged");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter pull requests">
        {FILTERS.map((f) => (
          <Button key={f.key} size="sm" variant="ghost" aria-pressed={filter === f.key} onClick={() => choose(f.key)}>
            <Icon name={f.icon} fallback="Circle" aria-hidden />
            {f.label} ({count(f.key)})
          </Button>
        ))}
      </div>
      {authOk ? null : <p className="text-xs text-muted-foreground">PR state needs GitHub auth.</p>}
      {!rows.length ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center">
          <p className="text-sm font-medium text-foreground">No {current.empty} pull requests</p>
          {filter === "needs" && merged ? <Button size="sm" variant="outline" onClick={() => choose("merged")}>Show merged ({merged})</Button> : null}
        </div>
      ) : (
        <ul className="divide-y divide-border" aria-label="Pull requests">
          {rows.slice(0, shown).map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm" title={e.pr ? `PR state checked ${relative(e.pr.checkedAt, now)}` : undefined}>
              <PrStatePill pr={e.pr} />
              {isFinished(e) ? null : stage(e)}
              <span className="inline-flex items-center gap-1 font-medium tabular-nums">{e.prUrl ? <UrlLink href={e.prUrl}>PR #{e.prNumber}</UrlLink> : `PR #${e.prNumber}`}</span>
              {e.issueTitle ? <span className="line-clamp-2 min-w-0 basis-full text-foreground sm:line-clamp-1 sm:flex-1 sm:basis-0" title={e.issueTitle}>{e.issueTitle}</span> : null}
              {e.fixAttempts ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={`${e.fixAttempts} CI fix cycles`}>
                  <Icon name="Wrench" fallback="Circle" className="size-3.5" aria-hidden />
                  {e.fixAttempts}
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {e.repo.split("/")[1] ?? e.repo}
                {e.issueUrl ? <> · closes <UrlLink href={e.issueUrl}><span className="sr-only">issue </span>#{e.issueNumber}</UrlLink></> : e.issueNumber ? ` · closes #${e.issueNumber}` : ""} · {relative(e.lastActivityAt ?? e.startedAt, now)}
              </span>
              {action ? action(e) : null}
            </li>
          ))}
        </ul>
      )}
      {rows.length > shown ? (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setShown((n) => n + PR_PAGE)}>
          Show more ({rows.length - shown} more)
        </Button>
      ) : null}
    </div>
  );
}
