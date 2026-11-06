// Persistent state in the plugin's SQLite database (bb.storage.database()).
// Tables: work_items (task -> stages -> PR) and activity_log. routine_runs and
// routine_schedule are left over from the removed routines feature.
import type { Database } from "better-sqlite3";
import type { Stage, StageOrDone } from "./workflow";

/**
 * Who holds the ball inside the item's current stage:
 * - queued: waiting for a free agent slot
 * - agent: the agent (builder or reviewer) is working on the stage
 * - cos: Chief of Staff is running deterministic work (verify command, push, PR, merge)
 * - ci: the PR is open and CI is running or red
 * - ready: the PR is open and green, waiting to be merged
 * - waiting_on_human: you need to answer, approve or decide
 * - retrying: Chief of Staff hit an infrastructure error and retries with backoff
 * - blocked: the agent went quiet past the stall threshold
 */
export const WORK_STATUSES = ["queued", "agent", "cos", "ci", "ready", "waiting_on_human", "retrying", "blocked", "done", "failed"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/** Why an item waits on a human; drives what the answer panel offers. */
export const WAITING_KINDS = ["question", "plan_approval", "escalation", "no_report", "cos_error"] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];

export interface StageCounters {
  /** Verify failures sent back to Build. */
  verifyFailures: number;
  /** Review rounds that requested changes. */
  reviewRounds: number;
  /** CI failures sent back to Build. */
  ciFixes: number;
  /** Nudges sent in the current stage because the agent stopped without reporting. */
  nudges: number;
  /** Consecutive infrastructure retries of the pending effect. */
  infraRetries: number;
}
export const ZERO_COUNTERS: StageCounters = { verifyFailures: 0, reviewRounds: 0, ciFixes: 0, nudges: 0, infraRetries: 0 };

export type ReportOutcome = "done" | "changes_requested" | "failed" | "needs_input";
export interface StageReport {
  stage: Stage;
  outcome: ReportOutcome;
  summary: string;
  question?: string | null;
  at: string;
  /** "tool" when the agent called cos_report, "text" when parsed from its message. */
  via: "tool" | "text";
}

export interface WorkItem {
  id: string;
  repo: string; // owner/repo
  issueNumber: number | null;
  issueTitle: string;
  threadId: string | null;
  environmentId: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  status: WorkStatus;
  providerId: string | null;
  model: string | null;
  fixAttempts: number;
  retryCount: number;
  lastError: string | null;
  checkOutput: string | null;
  source: string; // "intake" | "watch" | "routine:<name>" | "cli" | "tool"
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  finishedAt: string | null;
  /** What the agent is waiting on a human for (its question, an approval), or null. */
  waitingReason: string | null;
  /** Current workflow stage. */
  stage: StageOrDone;
  waitingKind: WaitingKind | null;
  counters: StageCounters;
  /** Accepted stage reports, newest per stage (feed the next prompts and the PR body). */
  reports: Partial<Record<Stage, StageReport>>;
  /** A report the agent filed during its turn, acted on when the turn ends. */
  pendingReport: StageReport | null;
  reviewThreadId: string | null;
  /** After a CI fix, go from Verify straight back to this stage. */
  returnTo: Stage | null;
  /** When Chief of Staff last sent the agent a prompt (ms); idles before it belong to an older turn. */
  promptSentAt: number | null;
  /** Thread updatedAt (ms) of the last idle we handled, so events and sync never handle one twice. */
  idleSeenAt: number | null;
  /** Detached Chief of Staff job (verify command, ship) start time. */
  jobStartedAt: string | null;
  /** Earliest time to retry the pending effect after an infrastructure error. */
  retryAt: string | null;
  /** The effect to re-run on retry (JSON). */
  pendingEffect: string | null;
  /** Free-text task for items not backed by a GitHub issue. */
  taskBody: string | null;
}

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
];

const ACTIVE_STATUSES: WorkStatus[] = ["queued", "agent", "cos", "ci", "ready", "waiting_on_human", "retrying", "blocked"];
export function isActiveStatus(status: WorkStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

type Row = Record<string, unknown>;
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
    checkOutput: (row.check_output as string | null) ?? null,
    source: (row.source as string) ?? "intake",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastActivityAt: (row.last_activity_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    waitingReason: (row.waiting_reason as string | null) ?? null,
    stage: ((row.stage as string | null) ?? "build") as StageOrDone,
    waitingKind: (row.waiting_kind as WaitingKind | null) ?? null,
    counters: { ...ZERO_COUNTERS, ...parseJson<Partial<StageCounters>>(row.counters_json, {}) },
    reports: parseJson<WorkItem["reports"]>(row.reports_json, {}),
    pendingReport: parseJson<StageReport | null>(row.pending_report_json, null),
    reviewThreadId: (row.review_thread_id as string | null) ?? null,
    returnTo: (row.return_to as Stage | null) ?? null,
    promptSentAt: (row.prompt_sent_at as number | null) ?? null,
    idleSeenAt: (row.idle_seen_at as number | null) ?? null,
    jobStartedAt: (row.job_started_at as string | null) ?? null,
    retryAt: (row.retry_at as string | null) ?? null,
    pendingEffect: (row.pending_effect as string | null) ?? null,
    taskBody: (row.task_body as string | null) ?? null,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Defaults for the stage fields, so callers creating items only name what matters. */
export const NEW_ITEM_STAGE_FIELDS = {
  waitingReason: null,
  waitingKind: null,
  counters: ZERO_COUNTERS,
  reports: {},
  pendingReport: null,
  reviewThreadId: null,
  returnTo: null,
  promptSentAt: null,
  idleSeenAt: null,
  jobStartedAt: null,
  retryAt: null,
  pendingEffect: null,
  taskBody: null,
} satisfies Partial<WorkItem>;

function toRow(item: WorkItem): Record<string, unknown> {
  return {
    ...item,
    counters: JSON.stringify(item.counters),
    reports: JSON.stringify(item.reports),
    pendingReport: item.pendingReport ? JSON.stringify(item.pendingReport) : null,
  };
}

export class StateStore {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  // ---- work items ----
  insertWorkItem(item: Omit<WorkItem, "createdAt" | "updatedAt" | keyof typeof NEW_ITEM_STAGE_FIELDS> & Partial<Pick<WorkItem, keyof typeof NEW_ITEM_STAGE_FIELDS>>): WorkItem {
    const at = this.now().toISOString();
    const full: WorkItem = { ...NEW_ITEM_STAGE_FIELDS, ...item, createdAt: at, updatedAt: at };
    this.db
      .prepare(
        `INSERT INTO work_items (id, repo, issue_number, issue_title, thread_id, environment_id, branch, pr_number, pr_url, status, provider_id, model, fix_attempts, retry_count, last_error, check_output, source, created_at, updated_at, last_activity_at, finished_at, waiting_reason,
           stage, waiting_kind, counters_json, reports_json, pending_report_json, review_thread_id, return_to, prompt_sent_at, idle_seen_at, job_started_at, retry_at, pending_effect, task_body)
         VALUES (@id, @repo, @issueNumber, @issueTitle, @threadId, @environmentId, @branch, @prNumber, @prUrl, @status, @providerId, @model, @fixAttempts, @retryCount, @lastError, @checkOutput, @source, @createdAt, @updatedAt, @lastActivityAt, @finishedAt, @waitingReason,
           @stage, @waitingKind, @counters, @reports, @pendingReport, @reviewThreadId, @returnTo, @promptSentAt, @idleSeenAt, @jobStartedAt, @retryAt, @pendingEffect, @taskBody)`,
      )
      .run(toRow(full));
    return full;
  }

  updateWorkItem(id: string, patch: Partial<Omit<WorkItem, "id" | "createdAt">>): WorkItem | null {
    const current = this.getWorkItem(id);
    if (!current) return null;
    const next: WorkItem = { ...current, ...patch, updatedAt: this.now().toISOString() };
    this.db
      .prepare(
        `UPDATE work_items SET repo=@repo, issue_number=@issueNumber, issue_title=@issueTitle, thread_id=@threadId, environment_id=@environmentId, branch=@branch, pr_number=@prNumber, pr_url=@prUrl, status=@status, provider_id=@providerId, model=@model, fix_attempts=@fixAttempts, retry_count=@retryCount, last_error=@lastError, check_output=@checkOutput, source=@source, updated_at=@updatedAt, last_activity_at=@lastActivityAt, finished_at=@finishedAt, waiting_reason=@waitingReason,
           stage=@stage, waiting_kind=@waitingKind, counters_json=@counters, reports_json=@reports, pending_report_json=@pendingReport, review_thread_id=@reviewThreadId, return_to=@returnTo, prompt_sent_at=@promptSentAt, idle_seen_at=@idleSeenAt, job_started_at=@jobStartedAt, retry_at=@retryAt, pending_effect=@pendingEffect, task_body=@taskBody WHERE id=@id`,
      )
      .run(toRow(next));
    return next;
  }

  getWorkItem(id: string): WorkItem | null {
    const row = this.db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  /** The item a thread belongs to, as its builder or its reviewer. */
  getWorkItemByThread(threadId: string): WorkItem | null {
    const row = this.db.prepare(`SELECT * FROM work_items WHERE thread_id = ? OR review_thread_id = ? ORDER BY created_at DESC LIMIT 1`).get(threadId, threadId) as Row | undefined;
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

  countActive(repo: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM work_items WHERE repo = ? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`)
      .get(repo, ...ACTIVE_STATUSES) as { n: number };
    return row.n;
  }

  countActiveAll(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`).get(...ACTIVE_STATUSES) as { n: number };
    return row.n;
  }

  // ---- activity log ----
  log(entry: Omit<LogEntry, "id" | "at">): void {
    this.db
      .prepare(`INSERT INTO activity_log (at, level, kind, repo, work_item_id, message, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(this.now().toISOString(), entry.level, entry.kind, entry.repo ?? null, entry.workItemId ?? null, entry.message, entry.actor);
    // Keep the log bounded.
    this.db.prepare(`DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT 5000)`).run();
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
