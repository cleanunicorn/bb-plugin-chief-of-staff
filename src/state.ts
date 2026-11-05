// Persistent state in the plugin's SQLite database (bb.storage.database()).
// Tables: work_items (issue -> thread -> PR), routine_runs, activity_log.
import type { Database } from "better-sqlite3";

export const WORK_STATUSES = ["queued", "running", "checking", "pr_open", "ci_failed", "fixing", "waiting_on_human", "blocked", "done", "failed"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

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
}

export interface RoutineRun {
  id: string;
  routine: string;
  repo: string;
  triggeredBy: string;
  dryRun: boolean;
  status: "running" | "succeeded" | "failed" | "partial";
  startedAt: string;
  finishedAt: string | null;
  steps: RoutineStepResult[];
}

export interface RoutineStepResult {
  index: number;
  type: string;
  status: "succeeded" | "failed" | "skipped" | "dry_run";
  summary: string;
  details?: unknown;
  startedAt: string;
  finishedAt: string;
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
];

const ACTIVE_STATUSES: WorkStatus[] = ["queued", "running", "checking", "pr_open", "ci_failed", "fixing", "waiting_on_human", "blocked"];
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
  };
}

function rowToRun(row: Row): RoutineRun {
  return {
    id: row.id as string,
    routine: row.routine as string,
    repo: row.repo as string,
    triggeredBy: row.triggered_by as string,
    dryRun: Boolean(row.dry_run),
    status: row.status as RoutineRun["status"],
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    steps: JSON.parse((row.steps_json as string) || "[]") as RoutineStepResult[],
  };
}

export class StateStore {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  // ---- work items ----
  insertWorkItem(item: Omit<WorkItem, "createdAt" | "updatedAt">): WorkItem {
    const at = this.now().toISOString();
    const full: WorkItem = { ...item, createdAt: at, updatedAt: at };
    this.db
      .prepare(
        `INSERT INTO work_items (id, repo, issue_number, issue_title, thread_id, environment_id, branch, pr_number, pr_url, status, provider_id, model, fix_attempts, retry_count, last_error, check_output, source, created_at, updated_at, last_activity_at, finished_at)
         VALUES (@id, @repo, @issueNumber, @issueTitle, @threadId, @environmentId, @branch, @prNumber, @prUrl, @status, @providerId, @model, @fixAttempts, @retryCount, @lastError, @checkOutput, @source, @createdAt, @updatedAt, @lastActivityAt, @finishedAt)`,
      )
      .run(full);
    return full;
  }

  updateWorkItem(id: string, patch: Partial<Omit<WorkItem, "id" | "createdAt">>): WorkItem | null {
    const current = this.getWorkItem(id);
    if (!current) return null;
    const next: WorkItem = { ...current, ...patch, updatedAt: this.now().toISOString() };
    this.db
      .prepare(
        `UPDATE work_items SET repo=@repo, issue_number=@issueNumber, issue_title=@issueTitle, thread_id=@threadId, environment_id=@environmentId, branch=@branch, pr_number=@prNumber, pr_url=@prUrl, status=@status, provider_id=@providerId, model=@model, fix_attempts=@fixAttempts, retry_count=@retryCount, last_error=@lastError, check_output=@checkOutput, source=@source, updated_at=@updatedAt, last_activity_at=@lastActivityAt, finished_at=@finishedAt WHERE id=@id`,
      )
      .run(next);
    return next;
  }

  getWorkItem(id: string): WorkItem | null {
    const row = this.db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  getWorkItemByThread(threadId: string): WorkItem | null {
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

  // ---- routine runs ----
  insertRun(run: RoutineRun): void {
    this.db
      .prepare(`INSERT INTO routine_runs (id, routine, repo, triggered_by, dry_run, status, started_at, finished_at, steps_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.id, run.routine, run.repo, run.triggeredBy, run.dryRun ? 1 : 0, run.status, run.startedAt, run.finishedAt, JSON.stringify(run.steps));
  }

  updateRun(run: RoutineRun): void {
    this.db.prepare(`UPDATE routine_runs SET status = ?, finished_at = ?, steps_json = ? WHERE id = ?`).run(run.status, run.finishedAt, JSON.stringify(run.steps), run.id);
  }

  listRuns(opts: { routine?: string; limit?: number } = {}): RoutineRun[] {
    const rows = opts.routine
      ? (this.db.prepare(`SELECT * FROM routine_runs WHERE routine = ? ORDER BY started_at DESC LIMIT ?`).all(opts.routine, opts.limit ?? 50) as Row[])
      : (this.db.prepare(`SELECT * FROM routine_runs ORDER BY started_at DESC LIMIT ?`).all(opts.limit ?? 50) as Row[]);
    return rows.map(rowToRun);
  }

  getRun(id: string): RoutineRun | null {
    const row = this.db.prepare(`SELECT * FROM routine_runs WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToRun(row) : null;
  }

  /** Mark runs left in "running" by a crash as failed. */
  failOrphanRuns(): number {
    const at = this.now().toISOString();
    const result = this.db.prepare(`UPDATE routine_runs SET status = 'failed', finished_at = ? WHERE status = 'running'`).run(at);
    return result.changes;
  }

  // ---- routine schedule bookkeeping ----
  getLastRunAt(routine: string): string | null {
    const row = this.db.prepare(`SELECT last_run_at FROM routine_schedule WHERE routine = ?`).get(routine) as { last_run_at: string | null } | undefined;
    return row?.last_run_at ?? null;
  }

  setLastRunAt(routine: string, at: string): void {
    this.db
      .prepare(`INSERT INTO routine_schedule (routine, last_run_at) VALUES (?, ?) ON CONFLICT(routine) DO UPDATE SET last_run_at = excluded.last_run_at`)
      .run(routine, at);
  }

  getEnabledOverride(routine: string): boolean | null {
    const row = this.db.prepare(`SELECT enabled_override FROM routine_schedule WHERE routine = ?`).get(routine) as { enabled_override: number | null } | undefined;
    if (!row || row.enabled_override === null || row.enabled_override === undefined) return null;
    return Boolean(row.enabled_override);
  }

  setEnabledOverride(routine: string, enabled: boolean | null): void {
    this.db
      .prepare(`INSERT INTO routine_schedule (routine, enabled_override) VALUES (?, ?) ON CONFLICT(routine) DO UPDATE SET enabled_override = excluded.enabled_override`)
      .run(routine, enabled === null ? null : enabled ? 1 : 0);
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
