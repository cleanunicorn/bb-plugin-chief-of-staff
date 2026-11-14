// The Finished section of the Pipeline tab (#105): finished tasks as compact rows, newest first, grouped by
// the day they finished, below the active grid so history never mixes with active work.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Ref } from "react";
import { UrlLink, experimental_useRpcQuery, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../rpcContract";
import { FAILED_OUTCOMES, MARKED_FAILED, OUTCOME_META } from "../../src/outcome";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { Panel, StatusPill } from "./viz";
import type { Tone } from "./viz";
import { PrStatePill } from "./prState";
import { CARD_ATTRIBUTE, ENTRY_ATTRIBUTE, useRovingCards } from "./rovingCards";
import { TaskActionsMenu, taskTitle, type Confirmable, type ItemAction, type MenuTask } from "./taskActions";
import type { ActivityTask } from "./dashboardModel";
import { DEFAULT_FINISHED_VIEW, FINISHED_FIRST, FINISHED_STEP, FINISHED_VIEW_KEY, NO_FILTER, finishedTimer, groupByDay, isFiltering, loadedPast, matchesFinishedFilter, mergePages, parseFinishedView, rangeLabel, storedFinishedView, visibleSlice, type FinishedView, type OutcomeGroup } from "./finishedModel";
import { inputClass } from "./fields";

type Contract = typeof rpcContract;
export type FinishedEntry = PluginRpcResult<Contract["cos_roster"]>["entries"][number];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The finished tasks: the roster's first finished page (its own query, without token usage), then older pages
 * loaded on demand. `activeIds` are the tasks the active query lists; a retried task is active again and leaves
 * the list even while an older page still holds its finished copy.
 */
export function useFinishedTasks(activeIds: ReadonlySet<string>, onError: (message: string | null) => void) {
  const rpc = useRpc<Contract>();
  const query = experimental_useRpcQuery<Contract, "cos_roster">({ contract: rpcContract, method: "cos_roster", input: { includeDone: true, withUsage: false } });
  const firstEntries = query.data?.entries;
  // Older pages, after the first page's finished tasks as they were at the first load, so a task that drops
  // off the first page as newer ones finish is not lost. The first page's copy wins on duplicates.
  const [older, setOlder] = useState<{ entries: FinishedEntry[]; before: string | null } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The cursor whose page last failed to load: pages are not fetched for it again unasked.
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const inFlight = useRef(false);
  const cursor = older ? older.before : (query.data?.nextBefore ?? null);
  const entries = useMemo(() => mergePages(firstEntries ?? [], older?.entries ?? [], activeIds), [firstEntries, older, activeIds]);
  const loadOlder = useCallback(async () => {
    if (!cursor || inFlight.current) return;
    inFlight.current = true;
    setLoadingOlder(true);
    onError(null);
    setFailedCursor(null);
    const snapshot = (firstEntries ?? []).filter((e) => e.detail === "done" || e.detail === "failed");
    try {
      const page = await rpc.call("cos_roster", { includeDone: true, before: cursor, withUsage: false });
      setOlder((prev) => {
        const base = prev?.entries ?? snapshot;
        const seen = new Set(base.map((e) => e.id));
        return { entries: [...base, ...page.entries.filter((e) => !seen.has(e.id))], before: page.nextBefore ?? null };
      });
    } catch (error) {
      onError(errorText(error));
      setFailedCursor(cursor);
    } finally {
      inFlight.current = false;
      setLoadingOlder(false);
    }
  }, [cursor, firstEntries, onError, rpc]);
  return { query, entries, cursor, loadingOlder, loadOlder, failedCursor };
}

/** "acme/app" → "app". */
function repoName(repo: string): string {
  return repo.split("/")[1] ?? repo;
}

function outcomeMeta(entry: FinishedEntry): { tone: Tone; label: string; icon: string } {
  if (entry.outcome) return OUTCOME_META[entry.outcome];
  return entry.detail === "failed" ? { tone: "neutral", label: "Failed", icon: "CircleX" } : { tone: "good", label: "Done", icon: "CircleCheck" };
}

const FINISHED_KEYS_HINT_ID = "cos-finished-keys";
const control = "h-7 px-2 pointer-coarse:h-10";

type RowHandlers = {
  onAction: (id: string, action: ItemAction) => void;
  onAsk: (task: MenuTask, kind: Confirmable, trigger: HTMLButtonElement) => void;
  onWorkflow: (id: string, opener: HTMLElement, mode?: "canvas" | "list") => void;
  onShowActivity?: (task: ActivityTask) => void;
};

/** One finished task on one line where it fits: how it ended, title, repo and issue, PR, when it finished, and its actions. */
function FinishedRow({ entry, now, busy, tabbable, onAction, onAsk, onWorkflow, onShowActivity }: { entry: FinishedEntry; now: number; busy: boolean; tabbable: boolean } & RowHandlers) {
  const navigate = useBbNavigate();
  const title = taskTitle(entry);
  const meta = outcomeMeta(entry);
  const timer = finishedTimer(entry, now);
  const tabIndex = tabbable ? undefined : -1;
  // Why it ended, on tasks that did not deliver; a delivered task's stale error stays hidden.
  // MARKED_FAILED only repeats the outcome label.
  const endReason = entry.outcome && FAILED_OUTCOMES.includes(entry.outcome) && entry.lastError !== MARKED_FAILED ? entry.lastError : null;
  // A hand-failed task holding another error (stored before #146 wrote MARKED_FAILED) shows it as the last seen, not the cause.
  const reasonLead = entry.outcome === "marked_failed" ? "Last error:" : "Why it ended:";
  const titleId = `cos-finished-${entry.id}`;
  return (
    <article {...{ [CARD_ATTRIBUTE]: entry.id }} aria-labelledby={titleId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <StatusPill tone={meta.tone} label={meta.label} icon={meta.icon} />
      <p id={titleId} className="min-w-0 flex-1 basis-48 text-sm font-medium text-foreground [overflow-wrap:anywhere] sm:truncate" title={title}>{title}</p>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1" title={entry.repo}>
          <Icon name="FolderGit2" className="size-3.5 shrink-0" aria-hidden />
          {entry.issueUrl ? (
            <UrlLink href={entry.issueUrl} tabIndex={tabIndex}>{repoName(entry.repo)}<span className="sr-only"> issue</span> #{entry.issueNumber}</UrlLink>
          ) : (
            repoName(entry.repo)
          )}
        </span>
        {entry.prUrl ? (
          <span className="flex items-center gap-1">
            <UrlLink href={entry.prUrl} tabIndex={tabIndex} className="inline-flex items-center gap-1 font-medium text-foreground">
              <Icon name="GitPullRequest" fallback="Circle" className="size-3.5" aria-hidden />
              PR #{entry.prNumber}
            </UrlLink>
            {entry.pr ? <PrStatePill pr={entry.pr} compact /> : null}
          </span>
        ) : null}
        <span className="flex items-center gap-1 tabular-nums" title={timer.title} aria-label={timer.label}>
          <Icon name="CalendarCheck" fallback="Clock" className="size-3.5 shrink-0" aria-hidden />
          {timer.text}
        </span>
      </span>
      <span className="ml-auto flex items-center gap-1">
        {entry.threadId ? (
          <Button size="sm" variant="ghost" className={control} tabIndex={tabIndex} onClick={() => navigate.toThread(entry.threadId!)}>
            <Icon name="MessageSquare" fallback="Circle" aria-hidden /> Open thread
          </Button>
        ) : null}
        {/* The arrow keys land here: the issue link comes first, but it leaves the plugin. */}
        <Button {...{ [ENTRY_ATTRIBUTE]: "" }} size="sm" variant="ghost" className={control} tabIndex={tabIndex} onClick={(event) => onWorkflow(entry.id, event.currentTarget)}>
          <Icon name="Network" fallback="Workflow" aria-hidden /> Workflow
        </Button>
        <TaskActionsMenu task={entry} busy={busy} tabIndex={tabIndex} onAction={onAction} onAsk={onAsk} onRerun={(id, trigger) => onWorkflow(id, trigger, "list")} onShowActivity={onShowActivity} />
      </span>
      {endReason ? (
        <p className="flex basis-full items-start gap-1.5 text-xs text-foreground">
          {/* Muted: a failed run is history, not an alarm (#22). */}
          <Icon name="Info" fallback="Circle" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]" title={endReason}><span className="text-muted-foreground">{reasonLead}</span> {endReason}</span>
        </p>
      ) : null}
    </article>
  );
}

function loadView(): FinishedView {
  try {
    return parseFinishedView(JSON.parse(localStorage.getItem(FINISHED_VIEW_KEY) ?? "null"));
  } catch {
    return DEFAULT_FINISHED_VIEW;
  }
}

function saveView(view: FinishedView): void {
  try {
    localStorage.setItem(FINISHED_VIEW_KEY, JSON.stringify(storedFinishedView(view)));
  } catch {
    /* storage unavailable: the view lasts while the dashboard is open */
  }
}

/**
 * The Finished section's view, read from local storage and saved on every change, so it survives reloads.
 * Hold it above the tab switch (the Dashboard does), so the date range survives switching tabs too.
 */
export function useFinishedView(): { view: FinishedView; update: (patch: Partial<FinishedView>) => void } {
  const [view, setView] = useState<FinishedView>(loadView);
  const update = useCallback((patch: Partial<FinishedView>) => {
    setView((v) => {
      const next = { ...v, ...patch };
      saveView(next);
      return next;
    });
  }, []);
  return { view, update };
}

export type FinishedViewState = ReturnType<typeof useFinishedView>;

const OUTCOME_FILTERS: { key: OutcomeGroup; label: string; icon: string }[] = [
  { key: "shipped", label: "Shipped", icon: "CircleCheck" },
  { key: "marked_done", label: "Marked done", icon: "UserCheck" },
  { key: "failed", label: "Failed", icon: "CircleX" },
];

function FinishedFilters({ view, repos, onChange }: { view: FinishedView; repos: string[]; onChange: (patch: Partial<FinishedView>) => void }) {
  const toggle = (key: OutcomeGroup) => onChange({ outcomes: view.outcomes.includes(key) ? view.outcomes.filter((k) => k !== key) : [...view.outcomes, key] });
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <input
        type="search"
        aria-label="Search finished tasks"
        placeholder="Search title or #number"
        className={cn(inputClass, "w-full sm:w-56 pointer-coarse:h-10")}
        value={view.query}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange({ query: event.target.value })}
      />
      <div role="group" aria-label="Outcome" className="flex flex-wrap items-center gap-1">
        {OUTCOME_FILTERS.map((o) => (
          <Button key={o.key} size="sm" variant="ghost" className="pointer-coarse:h-10" aria-pressed={view.outcomes.includes(o.key)} onClick={() => toggle(o.key)}>
            <Icon name={o.icon} fallback="Circle" aria-hidden />{o.label}
          </Button>
        ))}
      </div>
      {repos.length > 1 ? (
        <select aria-label="Repository" className={cn(inputClass, "w-auto pr-7 pointer-coarse:h-10")} value={view.repo ?? ""} onChange={(event) => onChange({ repo: event.target.value || null })}>
          <option value="">All repositories</option>
          {repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      ) : null}
      {view.range ? (
        <Button size="sm" variant="outline" className="pointer-coarse:h-10" aria-label={`Remove the date filter: finished ${rangeLabel(view.range)}`} onClick={() => onChange({ range: null })}>
          <Icon name="CalendarCheck" fallback="Clock" aria-hidden />Finished {rangeLabel(view.range)}<Icon name="X" fallback="Circle" aria-hidden />
        </Button>
      ) : null}
      {isFiltering(view) ? (
        <Button size="sm" variant="ghost" className="pointer-coarse:h-10" onClick={() => onChange(NO_FILTER)}>
          <Icon name="X" fallback="Circle" aria-hidden />Clear filters
        </Button>
      ) : null}
    </div>
  );
}

export type FinishedSectionProps = {
  finished: ReturnType<typeof useFinishedTasks>;
  now: number;
  busy: ReadonlySet<string>;
  view: FinishedView;
  onViewChange: (patch: Partial<FinishedView>) => void;
  /** Repositories to filter by, besides those of the loaded tasks. */
  repos: readonly string[];
  headingRef?: Ref<HTMLHeadingElement>;
} & RowHandlers;

/** Finished tasks as compact rows, newest first, by day: 10 at first, then 20 more per click. */
export function FinishedSection({ finished, now, busy, view, onViewChange, repos, headingRef, ...handlers }: FinishedSectionProps) {
  const { query, entries, cursor, loadingOlder, loadOlder, failedCursor } = finished;
  const filtering = isFiltering(view);
  const matching = useMemo(() => entries.filter((e) => matchesFinishedFilter(e, view)), [entries, view]);
  // Paging starts over when a filter changes.
  const filterKey = JSON.stringify([view.outcomes, view.repo, view.query.trim(), view.range]);
  const [paging, setPaging] = useState({ key: filterKey, shown: FINISHED_FIRST });
  const shown = paging.key === filterKey ? paging.shown : FINISHED_FIRST;
  const slice = visibleSlice(matching, shown);
  const roving = useRovingCards(slice.rows.map((e) => e.id));
  const groups = groupByDay(slice.rows, now);
  const repoOptions = useMemo(() => [...new Set([...repos, ...entries.map((e) => e.repo)])].sort(), [repos, entries]);
  const bodyId = "cos-finished-list";
  const count = query.data ? `${entries.length}${cursor ? "+" : ""}` : null;
  // A date range reaches back into older pages: load them until the loaded tasks pass its first day.
  const from = view.range?.from ?? null;
  useEffect(() => {
    if (from === null || !cursor || cursor === failedCursor || loadingOlder || loadedPast(entries, from)) return;
    void loadOlder();
  }, [from, cursor, failedCursor, loadingOlder, entries, loadOlder]);
  const showMore = () => {
    const next = shown + FINISHED_STEP;
    setPaging({ key: filterKey, shown: next });
    // Rendering runs past what is loaded: fetch the next page.
    if (matching.length < next && cursor) void loadOlder();
  };
  const searchOlder = (
    <Button size="sm" variant="outline" disabled={loadingOlder} aria-busy={loadingOlder} onClick={() => void loadOlder()}>
      <Icon name="History" fallback="Circle" aria-hidden />Search older
    </Button>
  );
  // Filters run over the loaded pages; older ones are fetched on request.
  const searchedNote = `Searched the ${entries.length} most recently finished ${entries.length === 1 ? "task" : "tasks"}.`;
  return (
    <Panel
      title={count === null ? "Finished" : `Finished · ${count}`}
      icon="History"
      headingRef={headingRef}
      dim={query.isFetching && !query.isLoading}
      actions={
        <Button size="sm" variant="ghost" aria-expanded={view.open} aria-controls={bodyId} onClick={() => onViewChange({ open: !view.open })}>
          <Icon name={view.open ? "ChevronDown" : "ChevronRight"} fallback="Circle" aria-hidden />
          {view.open ? "Collapse" : "Expand"}
        </Button>
      }
    >
      <div id={bodyId} hidden={!view.open}>
        {query.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {query.data && !entries.length && !cursor ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            <span className="block font-medium text-foreground">No finished tasks yet</span>
            Tasks show here once they ship, fail or are marked done.
          </p>
        ) : null}
        {entries.length || cursor || filtering ? <FinishedFilters view={view} repos={repoOptions} onChange={onViewChange} /> : null}
        {query.data && filtering && !matching.length && (entries.length || cursor) ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            <span className="font-medium text-foreground">No finished tasks match</span>
            {cursor ? <span>{searchedNote}</span> : <span>Change or clear the filters.</span>}
            <div className="flex flex-wrap justify-center gap-2">
              {cursor ? searchOlder : null}
              <Button size="sm" variant="ghost" onClick={() => onViewChange(NO_FILTER)}>
                <Icon name="X" fallback="Circle" aria-hidden />Clear filters
              </Button>
            </div>
          </div>
        ) : null}
        {slice.rows.length ? (
          // One tab stop group, like the active grid (#115): Tab visits the current row's controls only.
          <div role="group" aria-label="Finished tasks" aria-describedby={FINISHED_KEYS_HINT_ID} className="group/finished flex flex-col gap-1" {...roving.groupProps}>
            <p id={FINISHED_KEYS_HINT_ID} className="invisible text-xs text-muted-foreground group-focus-within/finished:visible">Arrow keys move between tasks.</p>
            {groups.map((group) => (
              <div key={group.key} className="flex flex-col">
                <h3 className="border-b border-border pb-1 text-xs font-semibold text-muted-foreground">{group.label}</h3>
                <ul className="flex flex-col divide-y divide-border">
                  {group.entries.map((e) => (
                    <li key={e.id}>
                      <FinishedRow entry={e} now={now} busy={busy.has(e.id)} tabbable={e.id === roving.current} {...handlers} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
        {slice.more || (cursor && !filtering) ? (
          <div className="mt-3 flex justify-center">
            <Button size="sm" variant="outline" disabled={loadingOlder} aria-busy={loadingOlder} onClick={showMore}>
              <Icon name="ChevronDown" fallback="Circle" aria-hidden />Show {FINISHED_STEP} more
            </Button>
          </div>
        ) : null}
        {filtering && cursor && slice.rows.length && !slice.more ? (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>{searchedNote}</span>
            {searchOlder}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
