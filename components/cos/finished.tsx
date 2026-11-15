// The Finished section of the Pipeline tab (#105): finished tasks as compact rows, newest first and grouped by
// the day they finished, or most tokens first, below the active grid so history never mixes with active work.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, Ref } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../rpcContract";
import { OUTCOME_META, endReason } from "../../src/outcome";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { Panel, StatusPill, compact } from "./viz";
import type { Tone } from "./viz";
import { PrStatePill } from "./prState";
import { CARD_ATTRIBUTE, ENTRY_ATTRIBUTE, useRovingCards } from "./rovingCards";
import { TaskActionsMenu, taskTitle, type Confirmable, type ItemAction, type MenuTask } from "./taskActions";
import { usageNote, type ActivityTask } from "./dashboardModel";
import { CARD_ACTION_ICON, CARD_ICON, DETAIL_ICON, FINISHED_ICON } from "./dashboardIcons";
import { LoadingRegion, Skeleton } from "./skeleton";
import { DEFAULT_FINISHED_VIEW, FINISHED_FIRST, FINISHED_STEP, FINISHED_VIEW_KEY, NO_FILTER, finishedTimer, groupByDay, isFiltering, loadedPast, matchesFinishedFilter, mergePages, parseFinishedView, rangeLabel, sharePercent, storedFinishedView, visibleSlice, type FinishedOrder, type FinishedView, type OutcomeGroup } from "./finishedModel";
import { inputClass } from "./fields";

type Contract = typeof rpcContract;
export type FinishedEntry = PluginRpcResult<Contract["cos_roster"]>["entries"][number];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Roster = PluginRpcResult<Contract["cos_roster"]>;
/** The Pipeline tab's roster query: every active task, then the first page of finished ones in `order`. */
export type RosterQuery = { data: Roster | undefined; isLoading: boolean; isFetching: boolean };

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The finished tasks: the roster query's first finished page, then older pages loaded on demand, all in `order`.
 * The roster query is shared with the active grid, so the live usage of active tasks is read once. A task the
 * first page lists as active (a retried one) leaves the list even while an older page still holds its finished copy.
 */
export function useFinishedTasks(query: RosterQuery, order: FinishedOrder, onError: (message: string | null) => void) {
  const rpc = useRpc<Contract>();
  const firstEntries = query.data?.entries;
  // Until the roster answers for the order chosen, its cursor belongs to the other order, which the server rejects.
  const orderLoaded = (query.data?.finishedOrder ?? "recent") === order;
  // Older pages, after the first page's finished tasks as they were at the first load, so a task that drops
  // off the first page as newer ones finish is not lost. The first page's copy wins on duplicates. Pages
  // belong to the order they were loaded in and are dropped when it changes.
  const [older, setOlder] = useState<{ order: FinishedOrder; entries: FinishedEntry[]; before: string | null } | null>(null);
  const pages = older?.order === order ? older : null;
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The cursor whose page last failed to load: pages are not fetched for it again unasked.
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  // One request at a time per order; a page that answers after the order changed is dropped.
  const request = useRef<{ order: FinishedOrder; inFlight: boolean }>({ order, inFlight: false });
  useEffect(() => {
    if (request.current.order === order) return;
    request.current = { order, inFlight: false };
    setLoadingOlder(false);
    setFailedCursor(null);
  }, [order]);
  const cursor = !orderLoaded ? null : pages ? pages.before : (query.data?.nextBefore ?? null);
  const entries = useMemo(() => mergePages(firstEntries ?? [], pages?.entries ?? [], NO_IDS), [firstEntries, pages]);
  const loadOlder = useCallback(async () => {
    const req = request.current;
    if (!cursor || req.inFlight || req.order !== order) return;
    req.inFlight = true;
    setLoadingOlder(true);
    onError(null);
    setFailedCursor(null);
    const snapshot = (firstEntries ?? []).filter((e) => e.detail === "done" || e.detail === "failed");
    try {
      const page = await rpc.call("cos_roster", { includeDone: true, before: cursor, withUsage: true, finishedOrder: order });
      if (request.current !== req) return;
      setOlder((prev) => {
        const base = prev?.order === order ? prev.entries : snapshot;
        const seen = new Set(base.map((e) => e.id));
        return { order, entries: [...base, ...page.entries.filter((e) => !seen.has(e.id))], before: page.nextBefore ?? null };
      });
    } catch (error) {
      if (request.current !== req) return;
      onError(errorText(error));
      setFailedCursor(cursor);
    } finally {
      req.inFlight = false;
      if (request.current === req) setLoadingOlder(false);
    }
  }, [cursor, firstEntries, onError, order, rpc]);
  return { query, entries, cursor, loadingOlder, loadOlder, failedCursor, orderLoaded, finishedTokens: query.data?.finishedTokens ?? null };
}

/** "acme/app" → "app". */
function repoName(repo: string): string {
  return repo.split("/")[1] ?? repo;
}

function outcomeMeta(entry: FinishedEntry): { tone: Tone; label: string; icon: string } {
  if (entry.outcome) return OUTCOME_META[entry.outcome];
  return entry.detail === "failed" ? { tone: "neutral", label: "Failed", icon: DETAIL_ICON.failed } : { tone: "good", label: "Done", icon: DETAIL_ICON.done };
}

const FINISHED_KEYS_HINT_ID = "cos-finished-keys";
const control = "h-7 px-2 pointer-coarse:h-10";

type RowHandlers = {
  onAction: (id: string, action: ItemAction) => void;
  onAsk: (task: MenuTask, kind: Confirmable, trigger: HTMLButtonElement) => void;
  onWorkflow: (id: string, opener: HTMLElement, mode?: "canvas" | "list") => void;
  onShowActivity?: (task: ActivityTask) => void;
};

/**
 * One finished task on one line where it fits: how it ended, title, repo and issue, PR, when it finished, its
 * tokens and share of all finished tasks' tokens, and its actions. `finishedTokens`: that total, null when unknown.
 */
function FinishedRow({ entry, finishedTokens, now, busy, tabbable, onAction, onAsk, onWorkflow, onShowActivity }: { entry: FinishedEntry; finishedTokens: number | null; now: number; busy: boolean; tabbable: boolean } & RowHandlers) {
  const navigate = useBbNavigate();
  const title = taskTitle(entry);
  const meta = outcomeMeta(entry);
  const timer = finishedTimer(entry, now);
  const tabIndex = tabbable ? undefined : -1;
  // Why it ended, on tasks that did not deliver; a delivered task's stale error stays hidden.
  const reason = endReason(entry.outcome, entry.lastError);
  // Usage covers every agent thread of the task (planner, reviewers, replaced builders).
  const usage = entry.usage;
  const share = usage?.counted && usage.totalTokens != null && finishedTokens ? sharePercent(usage.totalTokens, finishedTokens) : null;
  // A hand-failed task holding another error (stored before #146 wrote MARKED_FAILED) shows it as the last seen, not the cause.
  const reasonLead = entry.outcome === "marked_failed" ? "Last error:" : "Why it ended:";
  const titleId = `cos-finished-${entry.id}`;
  return (
    <article {...{ [CARD_ATTRIBUTE]: entry.id }} aria-labelledby={titleId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1">
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
          <Icon name={CARD_ICON.finishedAge} fallback="Clock" className="size-3.5 shrink-0" aria-hidden />
          {timer.text}
        </span>
        {usage && (!usage.counted || usage.totalTokens != null) ? (
          <span className="flex items-center gap-1 tabular-nums" title={usageNote(usage)}>
            <Icon name={CARD_ICON.tokens} fallback="Circle" className="size-3.5 shrink-0" aria-hidden />
            {usage.totalTokens != null ? `${compact(usage.totalTokens)} tokens` : "Counting tokens…"}
            {share ? (
              <span className="flex items-center gap-1" title={`${share} of finished tasks' tokens`}>
                {" · "}<Icon name={CARD_ICON.share} fallback="Circle" className="size-3.5 shrink-0" aria-hidden />{share}<span className="sr-only"> of finished tasks' tokens</span>
              </span>
            ) : null}
          </span>
        ) : null}
        {usage?.cost != null ? (
          <span className="flex items-center gap-1 tabular-nums" title={usageNote(usage)}>
            <Icon name={CARD_ICON.cost} fallback="Circle" className="size-3.5 shrink-0" aria-hidden />
            {usage.cost.amount.toFixed(2)} {usage.cost.currency}
          </span>
        ) : null}
      </span>
      <span className="ml-auto flex items-center gap-1">
        {entry.threadId ? (
          <Button size="sm" variant="ghost" className={control} tabIndex={tabIndex} onClick={() => navigate.toThread(entry.threadId!)}>
            <Icon name={CARD_ACTION_ICON.openThread} fallback="Circle" aria-hidden /> Open thread
          </Button>
        ) : null}
        {/* The arrow keys land here: the issue link comes first, but it leaves the plugin. */}
        <Button {...{ [ENTRY_ATTRIBUTE]: "" }} size="sm" variant="ghost" className={control} tabIndex={tabIndex} onClick={(event) => onWorkflow(entry.id, event.currentTarget)}>
          <Icon name={CARD_ACTION_ICON.workflow} fallback="Workflow" aria-hidden /> Workflow
        </Button>
        <TaskActionsMenu task={entry} busy={busy} tabIndex={tabIndex} onAction={onAction} onAsk={onAsk} onRerun={(id, trigger) => onWorkflow(id, trigger, "list")} onShowActivity={onShowActivity} />
      </span>
      {reason ? (
        <p className="flex basis-full items-start gap-1.5 text-xs text-foreground">
          {/* Muted: a failed run is history, not an alarm (#22). */}
          <Icon name="Info" fallback="Circle" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]" title={reason}><span className="text-muted-foreground">{reasonLead}</span> {reason}</span>
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
 * `enabled: false` skips reading storage, for a fallback copy that is not used.
 */
export function useFinishedView(enabled = true): { view: FinishedView; update: (patch: Partial<FinishedView>) => void } {
  const [view, setView] = useState<FinishedView>(() => (enabled ? loadView() : DEFAULT_FINISHED_VIEW));
  // Saved only when the view changes, never on mount: a copy that was just read has nothing new to write.
  const changed = useRef(false);
  useEffect(() => {
    if (changed.current) saveView(view);
  }, [view]);
  const update = useCallback((patch: Partial<FinishedView>) => {
    changed.current = true;
    setView((v) => ({ ...v, ...patch }));
  }, []);
  return { view, update };
}

export type FinishedViewState = ReturnType<typeof useFinishedView>;

const OUTCOME_FILTERS: { key: OutcomeGroup; label: string; icon: string }[] = [
  { key: "shipped", label: "Shipped", icon: FINISHED_ICON.shipped },
  { key: "marked_done", label: "Marked done", icon: FINISHED_ICON.markedDone },
  { key: "failed", label: "Failed", icon: FINISHED_ICON.failed },
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
          <Icon name={CARD_ICON.finishedAge} fallback="Clock" aria-hidden />Finished {rangeLabel(view.range)}<Icon name="X" fallback="Circle" aria-hidden />
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
  /** Set to the rows' j/k mover, so the page-wide j and k move between finished rows while focus is in them. */
  moveRef?: MutableRefObject<((delta: number) => boolean) | null>;
} & RowHandlers;

/** Finished tasks as compact rows, newest first by day or most tokens first: 8 at first, then 20 more per click. */
export function FinishedSection({ finished, now, busy, view, onViewChange, repos, headingRef, moveRef, ...handlers }: FinishedSectionProps) {
  const { query, entries, cursor, loadingOlder, loadOlder, failedCursor, orderLoaded, finishedTokens } = finished;
  const byTokens = view.order === "tokens";
  const filtering = isFiltering(view);
  const matching = useMemo(() => entries.filter((e) => matchesFinishedFilter(e, view)), [entries, view]);
  // Paging starts over when a filter or the order changes.
  const filterKey = JSON.stringify([view.order, view.outcomes, view.repo, view.query.trim(), view.range]);
  const [paging, setPaging] = useState({ key: filterKey, shown: FINISHED_FIRST });
  const shown = paging.key === filterKey ? paging.shown : FINISHED_FIRST;
  const slice = visibleSlice(matching, shown);
  // Days only make sense newest first: most tokens first is one list in the server's order.
  const groups = byTokens ? [{ key: "tokens", label: "", entries: slice.rows }] : groupByDay(slice.rows, now);
  // In the order rendered: rows without a finish time move to the end, under "Earlier".
  const roving = useRovingCards(groups.flatMap((g) => g.entries.map((e) => e.id)));
  const move = roving.move;
  useEffect(() => {
    if (!moveRef) return;
    moveRef.current = move;
    return () => {
      if (moveRef.current === move) moveRef.current = null;
    };
  }, [moveRef, move]);
  // A stored repository stays listed even when none of its tasks is loaded, so the select shows what is filtered.
  const repoOptions = useMemo(() => [...new Set([...repos, ...entries.map((e) => e.repo), ...(view.repo ? [view.repo] : [])])].sort(), [repos, entries, view.repo]);
  const bodyId = "cos-finished-list";
  const count = query.data ? `${entries.length}${cursor ? "+" : ""}` : null;
  // A date range reaches back into older pages: while the section is open, load them until the loaded tasks
  // pass its first day. Only newest first, where the pages are in date order. A page that failed is not
  // fetched again unasked.
  const from = view.range?.from ?? null;
  const pastRange = !byTokens && from !== null && loadedPast(entries, from);
  const loadingRange = !byTokens && view.open && from !== null && !!cursor && cursor !== failedCursor && !pastRange;
  useEffect(() => {
    if (loadingRange && !loadingOlder) void loadOlder();
  }, [loadingRange, loadingOlder, loadOlder]);
  // Older pages may still hold matches: not once the loaded tasks reach past a date range.
  const olderMayMatch = !!cursor && !pastRange;
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
  const searchedNote = `Searched the ${entries.length} ${byTokens ? "finished" : "most recently finished"} ${entries.length === 1 ? "task" : "tasks"}${byTokens ? " with the most tokens" : ""}.`;
  // Until the roster answers for a newly chosen order, the rows are the other order's: say nothing matches only once it has.
  const settled = !!query.data && orderLoaded;
  return (
    <Panel
      title={count === null ? "Finished" : `Finished · ${count}`}
      icon={FINISHED_ICON.panel}
      headingRef={headingRef}
      dim={query.isFetching && !query.isLoading}
      actions={
        <>
          {view.open ? (
            <div role="group" aria-label="Order finished tasks" className="flex items-center gap-1">
              <Button size="sm" variant="ghost" aria-pressed={!byTokens} onClick={() => onViewChange({ order: "recent" })}>
                <Icon name={CARD_ICON.finishedAge} fallback="Clock" aria-hidden />Recently finished
              </Button>
              <Button size="sm" variant="ghost" aria-pressed={byTokens} onClick={() => onViewChange({ order: "tokens" })}>
                <Icon name={CARD_ICON.tokens} fallback="Circle" aria-hidden />Most tokens
              </Button>
            </div>
          ) : null}
          <Button size="sm" variant="ghost" aria-expanded={view.open} aria-controls={bodyId} onClick={() => onViewChange({ open: !view.open })}>
            <Icon name={view.open ? "ChevronDown" : "ChevronRight"} fallback="Circle" aria-hidden />
            {view.open ? "Collapse" : "Expand"}
          </Button>
        </>
      }
    >
      <div id={bodyId} hidden={!view.open}>
        {query.isLoading ? (
          <LoadingRegion label="Loading finished tasks…" className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-6 w-full" />)}
          </LoadingRegion>
        ) : null}
        {query.data && !entries.length && !cursor ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            <span className="block font-medium text-foreground">No finished tasks yet</span>
            Tasks show here once they ship, fail or are marked done.
          </p>
        ) : null}
        {entries.length || cursor || filtering ? <FinishedFilters view={view} repos={repoOptions} onChange={onViewChange} /> : null}
        {query.data && filtering && !matching.length && loadingRange ? (
          <p role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Loading older finished tasks…</p>
        ) : null}
        {settled && filtering && !matching.length && !loadingRange && (entries.length || cursor) ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            <span className="font-medium text-foreground">No finished tasks match</span>
            {olderMayMatch ? <span>{searchedNote}</span> : <span>Change or clear the filters.</span>}
            <div className="flex flex-wrap justify-center gap-2">
              {olderMayMatch ? searchOlder : null}
              <Button size="sm" variant="ghost" onClick={() => onViewChange(NO_FILTER)}>
                <Icon name="X" fallback="Circle" aria-hidden />Clear filters
              </Button>
            </div>
          </div>
        ) : null}
        {slice.rows.length ? (
          // One tab stop group, like the active grid (#115): Tab visits the current row's controls only.
          <div role="group" aria-label="Finished tasks" aria-describedby={FINISHED_KEYS_HINT_ID} className="group/finished flex flex-col gap-1" {...roving.groupProps}>
            {groups.map((group, index) => (
              <div key={group.key} className="flex flex-col">
                <div className={cn("flex flex-wrap items-baseline gap-x-3 border-b border-border pb-1", group.label ? "justify-between" : "justify-end")}>
                  {group.label ? <h3 className="text-xs font-semibold text-muted-foreground">{group.label}</h3> : null}
                  {/* On the first day's line, so it takes no row of its own; visible only while focus is in the rows. */}
                  {index === 0 ? <p id={FINISHED_KEYS_HINT_ID} className="invisible text-xs text-muted-foreground group-focus-within/finished:visible">Arrow keys or j and k move between tasks.</p> : null}
                </div>
                <ul className="flex flex-col divide-y divide-border">
                  {group.entries.map((e) => (
                    <li key={e.id}>
                      <FinishedRow entry={e} finishedTokens={finishedTokens} now={now} busy={busy.has(e.id)} tabbable={e.id === roving.current} {...handlers} />
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
        {filtering && olderMayMatch && !loadingRange && slice.rows.length > 0 && !slice.more ? (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>{searchedNote}</span>
            {searchOlder}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
