// The icon names the dashboard requests, in one place so tests/hostIcons.test.ts resolves exactly what the UI asks
// for through the host translation table (components/ui/icon.tsx). Pure data: stages.ts imports it, so no imports here.

/** A stalled task: the card's state mark, its Stalled pill, the `blocked` detail and the Needs-attention chip. */
export const STALLED_ICON = "Hourglass";

/** The dashboard groups (stages.ts STAGES) and their filter chips. */
export const STAGE_ICON = {
  queued: "ListEnd", // waiting its turn; Clock is a task's age
  agent: "Bot",
  cos: "Cog",
  pr: "GitPullRequest",
  human: "Hand",
} as const;

/** What a task waits on the user for: label and state mark. */
export const WAITING_LABEL: Record<string, { label: string; icon: string }> = {
  approval: { label: "Approve", icon: "ClipboardCheck" },
  stalled: { label: "Stalled", icon: STALLED_ICON },
  question: { label: "Question", icon: "MessageCircleQuestion" },
  escalation: { label: "Your call", icon: "Hand" },
  no_report: { label: "No report", icon: "MessageSquareWarning" },
  cos_error: { label: "CoS stuck", icon: "OctagonAlert" },
};

/** A card's state mark per roster detail, where the detail decides it (app.tsx entryTone). */
export const DETAIL_ICON = {
  done: "CircleCheck",
  failed: "CircleX",
  blocked: STALLED_ICON, // shown as "Stalled"
  retrying: "RefreshCw",
  agent: "Bot",
  ready: "GitMerge",
  ci: "GitPullRequest",
  unknown: "Circle",
} as const;

/** The rows of a task card besides its state mark. */
export const CARD_ICON = {
  age: "Timer",
  finishedAge: "CalendarCheck",
  lastActivity: "Activity",
  tokens: "AiContentGenerator01", // host name: Lucide has no token icon
  cost: "Coins",
  fixCycles: "Undo2", // sent back to fix, like Loop-backs; RefreshCw is the retrying state
  error: "CircleAlert",
} as const;

/** The card menu's "Show activity", which opens the Activity panel. */
export const SHOW_ACTIVITY_ICON = "Newspaper";

/** Panel titles on the dashboard. */
export const PANEL_ICON = {
  tasks: "Bot",
  throughput: "ChartColumn",
  capacity: "Gauge",
  activity: "Newspaper",
  repositories: "FolderGit2",
  intake: "Inbox",
  pullRequests: "GitPullRequest",
} as const;

/** The Needs-attention row. */
export const ATTENTION_ICON = {
  title: "Hand",
  failures: "CircleAlert",
  stalled: STALLED_ICON,
  input: "Hand",
} as const;

/** The filter row's own items; the stage chips use STAGE_ICON. "All" also heads the PR list's filters. */
export const FILTER_ICON = {
  all: "LayoutGrid",
  taskSlots: "Layers",
  showFinished: "History",
  hideFinished: "EyeOff",
} as const;

/** The Throughput panel's chart / table switch. */
export const VIEW_ICON = {
  chart: "ChartColumn",
  table: "Table",
} as const;

/** The summary row of a task's run view (taskRunView.tsx TaskSummary). */
export const TASK_SUMMARY_ICON = {
  status: "Activity",
  elapsed: "Timer",
  steps: "ListChecks",
  loopBacks: "Undo2",
  pr: "GitPullRequest",
  branch: "GitBranch",
} as const;
