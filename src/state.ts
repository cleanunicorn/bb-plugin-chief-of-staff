// Persistent state in the plugin's SQLite database (bb.storage.database()).
// Tables: work_items (a task, its workflow snapshot and the state of each
// step), item_threads (which agent thread works on which step), step_journal
// (what happened to each step, kept across re-runs) and activity_log. Columns from the fixed-stage model and the removed routines
// feature are left in place and unused.
// work_items also stores occupies_capacity (occupiesCapacity of the row, kept
// by every write and counted in SQL) and detail_pruned_at (when retention
// removed a finished item's step details; cleared when the item is active again)
// and final_usage_json (the builder thread's token usage, read once after the
// item finished; NULL until read, cleared when the item is active again or
// its builder thread changes).
import type { Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import type { JournalEntry, JournalKind, MachineEvent, NodeState, Nodes, StepReport } from "./machine";
import type { ThreadUsage } from "./threads";
import { normalizeWorkflow, type Workflow } from "./workflow";

/**
 * Who holds the ball, derived from the item's step states:
 * - queued: nothing started yet
 * - agent: an agent is working on a step
 * - cos: Chief of Staff is running a check, pushing or merging
 * - ci: the PR is open and CI is running
 * - ready: the PR is open and green, waiting to be merged
 * - waiting_on_human: a step waits for you (question, approval, decision)
 * - retrying: Chief of Staff hit an infrastructure error and retries with backoff
 * - blocked: an agent went quiet past the stall threshold
 */
export const WORK_STATUSES = ["queued", "agent", "cos", "ci", "ready", "waiting_on_human", "retrying", "blocked", "done", "failed"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/** Why a step waits on a human; drives what the answer panel offers. */
export const WAITING_KINDS = ["question", "approval", "escalation", "no_report", "cos_error", "stalled"] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];

export interface WorkItem {
  id: string;
  repo: string; // owner/repo
  issueNumber: number | null;
  issueTitle: string;
  /** The builder thread: where code-writing steps run. */
  threadId: string | null;
  environmentId: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  status: WorkStatus;
  providerId: string | null;
  model: string | null;
  /** Failures looped back across all steps (for the PR body and stats). */
  fixAttempts: number;
  retryCount: number;
  lastError: string | null;
  source: string; // "intake" | "task" | "tool"
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  finishedAt: string | null;
  /** First waiting step's reason and kind (derived; for the roster). */
  waitingReason: string | null;
  waitingKind: WaitingKind | null;
  /** Start time of the running Chief of Staff job (check, push, merge); results from older jobs are dropped. */
  jobStartedAt: string | null;
  /** Free-text task for items not backed by a GitHub issue. */
  taskBody: string | null;
  /** A transition deferred until this task can reserve capacity. */
  queuedEvent?: MachineEvent | null;
  /** The workflow the item runs, frozen when it started. */
  workflow: Workflow;
  /** State of each step. */
  nodes: Nodes;
  /** A finished item's usage, stored once read (all-null: the provider reports none); null until then. */
  finalUsage?: ThreadUsage | null;
}

/** An agent thread working for an item: the builder, or one agent on a read-only step. */
export interface ItemThread {
  threadId: string;
  itemId: string;
  role: "builder" | "step";
  /** For role "step". */
  stepId: string | null;
  agent: number;
  environmentId: string | null;
  /** The step round the thread was last prompted for. */
  round: number;
  /** When Chief of Staff last prompted it (ms); idles before that belong to an older turn. */
  promptSentAt: number | null;
  /** Thread updatedAt (ms) of the last idle handled. */
  idleSeenAt: number | null;
  /** A report the agent filed during its turn, acted on when the turn ends. */
  pendingReport: (StepReport & { step: string; round: number }) | null;
}

/** Journal rows kept across all tasks (details are clipped to 4,000 characters). */
export const JOURNAL_MAX_ROWS = 50_000;
/** Activity log rows kept. */
export const LOG_MAX_ROWS = 5_000;
/**
 * The log and the journal are pruned on the first write after start and then
 * once every this many rows, so they can briefly exceed their caps by about this much.
 */
export const PRUNE_EVERY = 100;

export interface StoreOptions {
  logMaxRows?: number;
  journalMaxRows?: number;
  pruneEvery?: number;
}

/** A stored journal entry. */
export type JournalRecord = JournalEntry & { id: number; at: string; actor: string };

export interface LogEntry {
  id: number;
  at: string;
  level: "info" | "warn" | "error";
  kind: string;
  repo: string | null;
  workItemId: string | null;
  message: string;
  actor: string;
}

// Append only: BB records each statement hash by index, including whitespace.
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    issue_number INTEGER,
    issue_title TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    environment_id TEXT,
    branch TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    status TEXT NOT NULL,
    provider_id TEXT,
    model TEXT,
    fix_attempts INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    check_output TEXT,
    source TEXT NOT NULL DEFAULT 'intake',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_activity_at TEXT,
    finished_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS work_items_repo_issue ON work_items(repo, issue_number)`,
  `CREATE INDEX IF NOT EXISTS work_items_thread ON work_items(thread_id)`,
  `CREATE TABLE IF NOT EXISTS routine_runs (
    id TEXT PRIMARY KEY,
    routine TEXT NOT NULL,
    repo TEXT NOT NULL,
    triggered_by TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    steps_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    level TEXT NOT NULL,
    kind TEXT NOT NULL,
    repo TEXT,
    work_item_id TEXT,
    message TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'system'
  )`,
  `CREATE TABLE IF NOT EXISTS routine_schedule (
    routine TEXT PRIMARY KEY,
    last_run_at TEXT,
    enabled_override INTEGER
  )`,
  `ALTER TABLE work_items ADD COLUMN waiting_reason TEXT`,
  `ALTER TABLE work_items ADD COLUMN stage TEXT NOT NULL DEFAULT 'build'`,
  `ALTER TABLE work_items ADD COLUMN waiting_kind TEXT`,
  `ALTER TABLE work_items ADD COLUMN counters_json TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE work_items ADD COLUMN reports_json TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE work_items ADD COLUMN pending_report_json TEXT`,
  `ALTER TABLE work_items ADD COLUMN review_thread_id TEXT`,
  `ALTER TABLE work_items ADD COLUMN return_to TEXT`,
  `ALTER TABLE work_items ADD COLUMN prompt_sent_at INTEGER`,
  `ALTER TABLE work_items ADD COLUMN idle_seen_at INTEGER`,
  `ALTER TABLE work_items ADD COLUMN job_started_at TEXT`,
  `ALTER TABLE work_items ADD COLUMN retry_at TEXT`,
  `ALTER TABLE work_items ADD COLUMN pending_effect TEXT`,
  `ALTER TABLE work_items ADD COLUMN task_body TEXT`,
  `CREATE INDEX IF NOT EXISTS work_items_review_thread ON work_items(review_thread_id)`,
  // Items in flight under the old single-turn machine map onto stages.
  `UPDATE work_items SET stage = CASE
     WHEN status IN ('checking') THEN 'verify'
     WHEN status IN ('pr_open', 'ci_failed') THEN 'ship'
     WHEN status = 'waiting_on_human' AND pr_number IS NOT NULL THEN 'ship'
     WHEN status = 'done' THEN 'done'
     ELSE 'build' END,
   waiting_kind = CASE
     WHEN status = 'waiting_on_human' AND last_error LIKE 'run_checks:%' THEN 'cos_error'
     WHEN status = 'waiting_on_human' THEN 'question'
     ELSE NULL END,
   return_to = CASE WHEN status = 'fixing' AND pr_number IS NOT NULL THEN 'ship' ELSE NULL END,
   status = CASE
     WHEN status IN ('running', 'fixing') THEN 'agent'
     WHEN status = 'checking' THEN 'cos'
     WHEN status IN ('pr_open', 'ci_failed') THEN 'ci'
     ELSE status END`,
  `ALTER TABLE work_items ADD COLUMN workflow_json TEXT`,
  `ALTER TABLE work_items ADD COLUMN nodes_json TEXT`,
  `CREATE TABLE IF NOT EXISTS item_threads (
    thread_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    role TEXT NOT NULL,
    step_id TEXT,
    agent INTEGER NOT NULL DEFAULT 0,
    environment_id TEXT,
    round INTEGER NOT NULL DEFAULT 0,
    prompt_sent_at INTEGER,
    idle_seen_at INTEGER,
    pending_report_json TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS item_threads_item ON item_threads(item_id)`,
  `UPDATE work_items SET waiting_kind = 'approval' WHERE waiting_kind = 'plan_approval'`,
  `ALTER TABLE work_items ADD COLUMN queued_event_json TEXT`,
  `CREATE TABLE IF NOT EXISTS cos_control (id INTEGER PRIMARY KEY CHECK (id = 1), paused INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS deferred_events (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, event_json TEXT NOT NULL, actor TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS paused_repos (repo TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS step_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    at TEXT NOT NULL,
    step_id TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    agent INTEGER,
    from_step TEXT,
    to_step TEXT,
    detail TEXT,
    actor TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS step_journal_item ON step_journal(item_id, id)`,
  // Whether the item holds a task slot (see occupiesCapacity); NULL until first computed.
  `ALTER TABLE work_items ADD COLUMN occupies_capacity INTEGER`,
  // When retention removed the finished item's step details.
  `ALTER TABLE work_items ADD COLUMN detail_pruned_at TEXT`,
  `CREATE INDEX IF NOT EXISTS work_items_status ON work_items(status)`,
  `CREATE INDEX IF NOT EXISTS work_items_created ON work_items(created_at)`,
  `UPDATE work_items SET occupies_capacity = 0 WHERE status IN ('done', 'failed')`,
  // Keep every branch of statsRows' OR filter indexed as finished history grows.
  `CREATE INDEX IF NOT EXISTS work_items_finished ON work_items(COALESCE(finished_at, updated_at))`,
  // A finished item's token usage, so the roster reads it from its thread once.
  `ALTER TABLE work_items ADD COLUMN final_usage_json TEXT`,
];

/** Preserve both shipped histories; the SDK still validates every recorded hash.
 * Append future migrations to MIGRATIONS: only indexes 27–29 differ. */
export function migrationsForDatabase(db: Database): string[] {
  const columns = db.prepare("PRAGMA table_info(_bb_migrations)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "statement_hash")) return MIGRATIONS;
  const row = db.prepare("SELECT statement_hash FROM _bb_migrations WHERE id = 27").get() as { statement_hash: string | null } | undefined;
  const pauseHash = createHash("sha256").update(MIGRATIONS[28]).digest("hex");
  if (row?.statement_hash !== pauseHash) return MIGRATIONS;
  return [...MIGRATIONS.slice(0, 27), MIGRATIONS[28], MIGRATIONS[29], MIGRATIONS[27], ...MIGRATIONS.slice(30)];
}

const ACTIVE_STATUSES: WorkStatus[] = ["queued", "agent", "cos", "ci", "ready", "waiting_on_human", "retrying", "blocked"];
/** SQL: `expr` (a column or parameter) is an active status. */
const activeIn = (expr: string) => `${expr} IN (${ACTIVE_STATUSES.map((s) => `'${s}'`).join(", ")})`;
const ACTIVE_IN = activeIn("status");
const FINISHED_IN = "status IN ('done', 'failed')";
export function isActiveStatus(status: WorkStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** Task reservations, distinct from unfinished work tracked for deduplication and CI. */
export function occupiesCapacity(item: Pick<WorkItem, "status" | "workflow" | "nodes" | "queuedEvent">): boolean {
  if (!isActiveStatus(item.status) || item.queuedEvent) return false;
  const outstanding = item.workflow.steps.filter((s) => ["running", "waiting"].includes(item.nodes[s.id]?.status));
  if (!outstanding.length) return true; // Newly admitted or legacy item.
  return outstanding.some((s) => {
    const n = item.nodes[s.id]!;
    if (s.type !== "ship") return true;
    return n.status === "running" && n.phase === "pushing";
  });
}

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Placeholder for rows written before workflows were stored per item (adopted at startup). */
export const NO_WORKFLOW: Workflow = { id: "none", name: "None", steps: [] };

/** Normalized snapshots, kept as JSON text so every read gets its own objects. */
const NORMALIZED_CACHE_SIZE = 256;
const normalizedCache = new Map<string, string>();

/**
 * Normalize a stored workflow snapshot, once per distinct text per process.
 * Not done on write: a snapshot picks up defaults added by later plugin
 * versions, and this cache is empty again after each restart.
 */
function readWorkflow(raw: unknown): Workflow {
  if (typeof raw !== "string" || !raw) return normalizeWorkflow(NO_WORKFLOW);
  let normalized = normalizedCache.get(raw);
  if (normalized === undefined) {
    normalized = JSON.stringify(normalizeWorkflow(parseJson<Workflow>(raw, NO_WORKFLOW)));
    if (normalizedCache.size >= NORMALIZED_CACHE_SIZE) normalizedCache.delete(normalizedCache.keys().next().value!);
    normalizedCache.set(raw, normalized);
  }
  return JSON.parse(normalized) as Workflow;
}

function rowToWorkItem(row: Row): WorkItem {
  return {
    id: row.id as string,
    repo: row.repo as string,
    issueNumber: (row.issue_number as number | null) ?? null,
    issueTitle: (row.issue_title as string) ?? "",
    threadId: (row.thread_id as string | null) ?? null,
    environmentId: (row.environment_id as string | null) ?? null,
    branch: (row.branch as string | null) ?? null,
    prNumber: (row.pr_number as number | null) ?? null,
    prUrl: (row.pr_url as string | null) ?? null,
    status: row.status as WorkStatus,
    providerId: (row.provider_id as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    fixAttempts: (row.fix_attempts as number) ?? 0,
    retryCount: (row.retry_count as number) ?? 0,
    lastError: (row.last_error as string | null) ?? null,
    source: (row.source as string) ?? "intake",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastActivityAt: (row.last_activity_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    waitingReason: (row.waiting_reason as string | null) ?? null,
    waitingKind: (row.waiting_kind as WaitingKind | null) ?? null,
    jobStartedAt: (row.job_started_at as string | null) ?? null,
    taskBody: (row.task_body as string | null) ?? null,
    workflow: readWorkflow(row.workflow_json),
    nodes: parseJson<Nodes>(row.nodes_json, {}),
    queuedEvent: parseJson<MachineEvent | null>(row.queued_event_json, null),
    finalUsage: parseJson<ThreadUsage | null>(row.final_usage_json, null),
  };
}

function rowToThread(row: Row): ItemThread {
  return {
    threadId: row.thread_id as string,
    itemId: row.item_id as string,
    role: row.role as ItemThread["role"],
    stepId: (row.step_id as string | null) ?? null,
    agent: (row.agent as number) ?? 0,
    environmentId: (row.environment_id as string | null) ?? null,
    round: (row.round as number) ?? 0,
    promptSentAt: (row.prompt_sent_at as number | null) ?? null,
    idleSeenAt: (row.idle_seen_at as number | null) ?? null,
    pendingReport: parseJson<ItemThread["pendingReport"]>(row.pending_report_json, null),
  };
}

const ITEM_COLUMNS = `repo=@repo, issue_number=@issueNumber, issue_title=@issueTitle, thread_id=@threadId, environment_id=@environmentId, branch=@branch, pr_number=@prNumber, pr_url=@prUrl, status=@status, provider_id=@providerId, model=@model, fix_attempts=@fixAttempts, retry_count=@retryCount, last_error=@lastError, source=@source, updated_at=@updatedAt, last_activity_at=@lastActivityAt, finished_at=@finishedAt, waiting_reason=@waitingReason, waiting_kind=@waitingKind, job_started_at=@jobStartedAt, task_body=@taskBody, workflow_json=@workflowJson, nodes_json=@nodesJson, queued_event_json=@queuedEventJson, occupies_capacity=@occupiesCapacity, detail_pruned_at=CASE WHEN ${activeIn("@status")} THEN NULL ELSE detail_pruned_at END, final_usage_json=CASE WHEN ${activeIn("@status")} OR thread_id IS NOT @threadId THEN NULL ELSE final_usage_json END`;

function toRow(item: WorkItem): Record<string, unknown> {
  // finalUsage is written only by setFinalUsage, and cleared by ITEM_COLUMNS.
  const { workflow, nodes, queuedEvent, finalUsage: _finalUsage, ...rest } = item;
  return {
    ...rest,
    queuedEventJson: queuedEvent ? JSON.stringify(queuedEvent) : null,
    workflowJson: workflow.steps.length ? JSON.stringify(workflow) : null,
    nodesJson: JSON.stringify(nodes),
    occupiesCapacity: occupiesCapacity(item) ? 1 : 0,
  };
}


/** Days after finishing that a task's step details are removed (the longest stats window). */
export const FINISHED_DETAIL_DAYS = 90;
/** Stands in for a report summary removed by retention. */
export const REMOVED_SUMMARY = `(removed ${FINISHED_DETAIL_DAYS} days after the task finished)`;

/**
 * A finished item's steps without their bulky text: outputs, feedback, report
 * summaries (replaced by REMOVED_SUMMARY) and questions. Statuses, rounds, report slots with their outcome,
 * choice and pick, waits and retries stay, so retry, revive and rerun behave as before.
 */
export function compactNodes(nodes: Nodes): Nodes {
  const out: Nodes = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (!node || typeof node !== "object") {
      out[id] = node;
      continue;
    }
    const compact: NodeState = { ...node, feedback: null, output: null };
    delete compact.deliveries;
    delete compact.agentRetries;
    if (Array.isArray(node.reports)) compact.reports = node.reports.map((r) => (r && typeof r === "object" ? { ...r, summary: REMOVED_SUMMARY, ...(r.question ? { question: null } : {}) } : r));
    out[id] = compact;
  }
  return out;
}

export type NewWorkItem = Omit<WorkItem, "createdAt" | "updatedAt" | "finalUsage" | "waitingReason" | "waitingKind" | "jobStartedAt" | "taskBody" | "fixAttempts" | "retryCount"> &
  Partial<Pick<WorkItem, "waitingReason" | "waitingKind" | "jobStartedAt" | "taskBody" | "fixAttempts" | "retryCount">>;

export class StateStore {
  private readonly caps: Required<StoreOptions>;
  /** Rows written since each table was last pruned; Infinity until the first prune of this process. */
  private readonly sincePrune = { activity_log: Infinity, step_journal: Infinity };

  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date(), options: StoreOptions = {}) {
    this.caps = { logMaxRows: LOG_MAX_ROWS, journalMaxRows: JOURNAL_MAX_ROWS, pruneEvery: PRUNE_EVERY, ...options };
  }

  /** Keep a table to its newest `max` rows (ids are AUTOINCREMENT), every `pruneEvery` rows written. */
  private prune(table: "activity_log" | "step_journal", written: number, max: number): void {
    this.sincePrune[table] += written;
    if (this.sincePrune[table] < this.caps.pruneEvery) return;
    this.sincePrune[table] = 0;
    this.db.prepare(`DELETE FROM ${table} WHERE id <= (SELECT MAX(id) FROM ${table}) - ?`).run(max);
  }

  /** Commit related synchronous writes together, or roll them all back. */
  transaction<T>(write: () => T): T {
    return this.db.transaction(write)();
  }

  /** Paused everywhere, or, when a repo is given, paused for that repo alone. */
  isPaused(repo?: string): boolean {
    if ((this.db.prepare("SELECT paused FROM cos_control WHERE id = 1").get() as { paused: number } | undefined)?.paused) return true;
    return repo !== undefined && this.isRepoPaused(repo);
  }

  isRepoPaused(repo: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM paused_repos WHERE repo = ?").get(repo));
  }

  setRepoPaused(repo: string, paused: boolean): void {
    if (paused) this.db.prepare("INSERT OR IGNORE INTO paused_repos (repo) VALUES (?)").run(repo);
    else this.db.prepare("DELETE FROM paused_repos WHERE repo = ?").run(repo);
  }

  setPaused(paused: boolean): void {
    this.db.prepare("INSERT INTO cos_control (id, paused) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET paused = excluded.paused").run(paused ? 1 : 0);
  }

  deferEvent(itemId: string, event: unknown, actor: string): void {
    this.db.prepare("INSERT INTO deferred_events (item_id, event_json, actor) VALUES (?, ?, ?)").run(itemId, JSON.stringify(event), actor);
  }

  nextDeferredEvent(): { id: number; item_id: string; event_json: string; actor: string } | undefined {
    // Events held for a paused repo wait; events of other repos (or of deleted items) replay.
    return this.db.prepare("SELECT d.id, d.item_id, d.event_json, d.actor FROM deferred_events d LEFT JOIN work_items w ON w.id = d.item_id WHERE w.repo IS NULL OR w.repo NOT IN (SELECT repo FROM paused_repos) ORDER BY d.id LIMIT 1").get() as { id: number; item_id: string; event_json: string; actor: string } | undefined;
  }

  deleteDeferredEvent(id: number): void { this.db.prepare("DELETE FROM deferred_events WHERE id = ?").run(id); }

  // ---- work items ----
  insertWorkItem(item: NewWorkItem): WorkItem {
    const at = this.now().toISOString();
    const full: WorkItem = { waitingReason: null, waitingKind: null, jobStartedAt: null, taskBody: null, fixAttempts: 0, retryCount: 0, ...item, createdAt: at, updatedAt: at, finalUsage: null };
    this.db
      .prepare(
        `INSERT INTO work_items (id, created_at, updated_at, status, repo) VALUES (@id, @createdAt, @createdAt, @status, @repo)`,
      )
      .run({ id: full.id, createdAt: at, status: full.status, repo: full.repo });
    this.db.prepare(`UPDATE work_items SET ${ITEM_COLUMNS} WHERE id=@id`).run(toRow(full));
    return full;
  }

  updateWorkItem(id: string, patch: Partial<Omit<WorkItem, "id" | "createdAt" | "finalUsage">>): WorkItem | null {
    const current = this.getWorkItem(id);
    if (!current) return null;
    const next: WorkItem = { ...current, ...patch, updatedAt: this.now().toISOString() };
    next.finalUsage = isActiveStatus(next.status) || next.threadId !== current.threadId ? null : (current.finalUsage ?? null);
    this.db.prepare(`UPDATE work_items SET ${ITEM_COLUMNS} WHERE id=@id`).run(toRow(next));
    return next;
  }

  /**
   * Store a finished item's usage, read from its builder thread. Leaves
   * updated_at alone (stats key on it) and sends no change event: the value
   * only saves the roster a read. False when the item is active or its
   * builder thread changed.
   */
  setFinalUsage(id: string, threadId: string, usage: ThreadUsage): boolean {
    return this.db.prepare(`UPDATE work_items SET final_usage_json = ? WHERE id = ? AND thread_id = ? AND ${FINISHED_IN}`).run(JSON.stringify(usage), id, threadId).changes > 0;
  }

  getWorkItem(id: string): WorkItem | null {
    const row = this.db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  /** The stage a row had under the fixed-stage model (for adopting old rows). */
  legacyStage(id: string): string | null {
    const row = this.db.prepare(`SELECT stage, review_thread_id FROM work_items WHERE id = ?`).get(id) as { stage: string | null } | undefined;
    return row?.stage ?? null;
  }

  /** The item a thread works for (builder or step thread). */
  getWorkItemByThread(threadId: string): WorkItem | null {
    const t = this.getThread(threadId);
    if (t) return this.getWorkItem(t.itemId);
    const row = this.db.prepare(`SELECT * FROM work_items WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`).get(threadId) as Row | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  findActiveForIssue(repo: string, issueNumber: number): WorkItem | null {
    const rows = this.db.prepare(`SELECT * FROM work_items WHERE repo = ? AND issue_number = ? ORDER BY created_at DESC`).all(repo, issueNumber) as Row[];
    for (const row of rows) {
      const item = rowToWorkItem(row);
      if (isActiveStatus(item.status)) return item;
    }
    return null;
  }

  listWorkItems(opts: { repo?: string; activeOnly?: boolean; limit?: number } = {}): WorkItem[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.repo) {
      where.push("repo = ?");
      params.push(opts.repo);
    }
    if (opts.activeOnly) {
      where.push(`status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`);
      params.push(...ACTIVE_STATUSES);
    }
    const sql = `SELECT * FROM work_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
    params.push(opts.limit ?? 200);
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToWorkItem);
  }

  /**
   * Remove the step details of up to `batch` items that finished before
   * `olderThanIso` (see compactNodes) and return their ids. Writes directly,
   * leaving updated_at alone so stats do not move; marks each row with
   * detail_pruned_at, even when its step state is unreadable, so repeated
   * batches end. Thread rows stay (the run view links them); their pending
   * reports go. Deferred events of these items go unless their project is paused.
   */
  compactFinished(olderThanIso: string, batch = 200): string[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT id, nodes_json FROM work_items WHERE ${FINISHED_IN} AND detail_pruned_at IS NULL AND COALESCE(finished_at, updated_at) < ? LIMIT ?`)
        .all(olderThanIso, batch) as { id: string; nodes_json: string | null }[];
      const at = this.now().toISOString();
      const update = this.db.prepare(`UPDATE work_items SET nodes_json = ?, check_output = NULL, pending_report_json = NULL, detail_pruned_at = ? WHERE id = ? AND ${FINISHED_IN}`);
      const threads = this.db.prepare("UPDATE item_threads SET pending_report_json = NULL WHERE item_id = ?");
      const events = this.db.prepare("DELETE FROM deferred_events WHERE item_id = @id AND NOT EXISTS (SELECT 1 FROM work_items w JOIN paused_repos p ON p.repo = w.repo WHERE w.id = @id)");
      for (const row of rows) {
        const nodes = parseJson<Nodes | null>(row.nodes_json, null);
        update.run(nodes && typeof nodes === "object" ? JSON.stringify(compactNodes(nodes)) : row.nodes_json, at, row.id);
        threads.run(row.id);
        events.run({ id: row.id });
      }
      return rows.map((row) => row.id);
    });
  }

  /** Scalar columns of every active item and every item started or finished since `sinceIso`, for computeStats. */
  statsRows(sinceIso: string): Pick<WorkItem, "status" | "createdAt" | "finishedAt" | "updatedAt">[] {
    return (this.db.prepare(`SELECT status, created_at, finished_at, updated_at FROM work_items WHERE ${ACTIVE_IN} OR created_at >= @since OR COALESCE(finished_at, updated_at) >= @since`)
      .all({ since: sinceIso }) as Row[])
      .map((row) => ({ status: row.status as WorkStatus, createdAt: row.created_at as string, finishedAt: (row.finished_at as string | null) ?? null, updatedAt: row.updated_at as string }));
  }

  countWorkItems(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n;
  }

  /** Count reservations without the roster's display limit, from the stored occupies_capacity column. */
  countOccupied(repo?: string, excludeId?: string): number {
    this.healReservations();
    const where = [ACTIVE_IN, "occupies_capacity = 1"];
    const params: string[] = [];
    if (repo !== undefined) { where.push("repo = ?"); params.push(repo); }
    if (excludeId !== undefined) { where.push("id <> ?"); params.push(excludeId); }
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE ${where.join(" AND ")}`).get(...params) as { n: number }).n;
  }

  /**
   * Compute occupies_capacity for active rows that predate the column (or
   * were written by raw SQL). Synchronous, so a count is never taken with
   * in-flight items unaccounted for; free once every row is healed.
   */
  private healReservations(): void {
    if (!this.db.prepare(`SELECT 1 FROM work_items WHERE ${ACTIVE_IN} AND occupies_capacity IS NULL LIMIT 1`).get()) return;
    const rows = this.db.prepare(`SELECT * FROM work_items WHERE ${ACTIVE_IN} AND occupies_capacity IS NULL`).all() as Row[];
    const write = this.db.prepare("UPDATE work_items SET occupies_capacity = ? WHERE id = ?");
    this.transaction(() => { for (const row of rows) write.run(occupiesCapacity(rowToWorkItem(row)) ? 1 : 0, row.id); });
  }

  // ---- item threads ----
  upsertThread(t: Omit<ItemThread, "idleSeenAt" | "pendingReport"> & Partial<Pick<ItemThread, "idleSeenAt" | "pendingReport">>): void {
    this.db
      .prepare(
        `INSERT INTO item_threads (thread_id, item_id, role, step_id, agent, environment_id, round, prompt_sent_at, idle_seen_at, pending_report_json, created_at)
         VALUES (@threadId, @itemId, @role, @stepId, @agent, @environmentId, @round, @promptSentAt, @idleSeenAt, @pendingReport, @createdAt)
         ON CONFLICT(thread_id) DO UPDATE SET item_id=excluded.item_id, role=excluded.role, step_id=excluded.step_id, agent=excluded.agent, environment_id=excluded.environment_id, round=excluded.round, prompt_sent_at=excluded.prompt_sent_at`,
      )
      .run({ ...t, idleSeenAt: t.idleSeenAt ?? null, pendingReport: t.pendingReport ? JSON.stringify(t.pendingReport) : null, createdAt: this.now().toISOString() });
  }

  updateThread(threadId: string, patch: Partial<Pick<ItemThread, "round" | "promptSentAt" | "idleSeenAt" | "pendingReport" | "environmentId">>): void {
    const cur = this.getThread(threadId);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.db
      .prepare(`UPDATE item_threads SET round=@round, prompt_sent_at=@promptSentAt, idle_seen_at=@idleSeenAt, pending_report_json=@pendingReport, environment_id=@environmentId WHERE thread_id=@threadId`)
      .run({ ...next, pendingReport: next.pendingReport ? JSON.stringify(next.pendingReport) : null });
  }

  getThread(threadId: string): ItemThread | null {
    const row = this.db.prepare(`SELECT * FROM item_threads WHERE thread_id = ?`).get(threadId) as Row | undefined;
    return row ? rowToThread(row) : null;
  }

  listThreads(itemId: string): ItemThread[] {
    return (this.db.prepare(`SELECT * FROM item_threads WHERE item_id = ? ORDER BY created_at`).all(itemId) as Row[]).map(rowToThread);
  }

  /** The thread for one agent on a read-only step. */
  stepThread(itemId: string, stepId: string, agent: number): ItemThread | null {
    const row = this.db.prepare(`SELECT * FROM item_threads WHERE item_id = ? AND role = 'step' AND step_id = ? AND agent = ? ORDER BY created_at DESC LIMIT 1`).get(itemId, stepId, agent) as Row | undefined;
    return row ? rowToThread(row) : null;
  }

  // ---- step journal ----
  appendJournal(itemId: string, entries: readonly JournalEntry[], actor: string): void {
    if (!entries.length) return;
    const at = this.now().toISOString();
    const insert = this.db.prepare(`INSERT INTO step_journal (item_id, at, step_id, round, kind, agent, from_step, to_step, detail, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of entries) insert.run(itemId, at, e.step, e.round, e.kind, e.agent ?? null, e.from ?? null, e.to ?? null, e.detail, actor);
    // Keep the journal bounded, like the activity log: the oldest entries go first.
    this.prune("step_journal", entries.length, this.caps.journalMaxRows);
  }

  /** The item's journal, oldest first; the most recent `limit` entries. */
  listJournal(itemId: string, limit = 500): JournalRecord[] {
    const rows = this.db.prepare(`SELECT * FROM (SELECT * FROM step_journal WHERE item_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`).all(itemId, limit) as Row[];
    return rows.map((row) => ({
      id: row.id as number,
      at: row.at as string,
      step: row.step_id as string,
      round: (row.round as number) ?? 0,
      kind: row.kind as JournalKind,
      ...(row.agent === null || row.agent === undefined ? {} : { agent: row.agent as number }),
      ...(row.from_step ? { from: row.from_step as string } : {}),
      ...(row.to_step ? { to: row.to_step as string } : {}),
      detail: (row.detail as string | null) ?? null,
      actor: row.actor as string,
    }));
  }

  /** One journal entry's full detail, or null when the entry is gone or belongs to another item. */
  journalDetail(itemId: string, id: number): string | null {
    const row = this.db.prepare(`SELECT detail FROM step_journal WHERE id = ? AND item_id = ?`).get(id, itemId) as { detail: string | null } | undefined;
    return row?.detail ?? null;
  }

  // ---- activity log ----
  log(entry: Omit<LogEntry, "id" | "at">): void {
    this.db
      .prepare(`INSERT INTO activity_log (at, level, kind, repo, work_item_id, message, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(this.now().toISOString(), entry.level, entry.kind, entry.repo ?? null, entry.workItemId ?? null, entry.message, entry.actor);
    this.prune("activity_log", 1, this.caps.logMaxRows);
  }

  listLog(opts: { limit?: number; workItemId?: string } = {}): LogEntry[] {
    const rows = opts.workItemId
      ? (this.db.prepare(`SELECT * FROM activity_log WHERE work_item_id = ? ORDER BY id DESC LIMIT ?`).all(opts.workItemId, opts.limit ?? 100) as Row[])
      : (this.db.prepare(`SELECT * FROM activity_log ORDER BY id DESC LIMIT ?`).all(opts.limit ?? 100) as Row[]);
    return rows.map((row) => ({
      id: row.id as number,
      at: row.at as string,
      level: row.level as LogEntry["level"],
      kind: row.kind as string,
      repo: (row.repo as string | null) ?? null,
      workItemId: (row.work_item_id as string | null) ?? null,
      message: row.message as string,
      actor: row.actor as string,
    }));
  }
}
