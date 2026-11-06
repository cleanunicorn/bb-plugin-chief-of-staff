// Dashboard grouping of work items by workflow stage, plus who holds the ball.
// In-flight stages take the ordinal blue ramp; stages that need attention take a status color.
import type { Palette, Tone } from "./viz";
import { STATUS } from "./viz";

export type StageKey = "queued" | "plan" | "build" | "verify" | "review" | "ship" | "human";

export interface Stage {
  key: StageKey;
  label: string;
  icon: string;
  ramp?: number;
  tone?: Exclude<Tone, "neutral" | "info">;
  hint: string;
}

export const STAGES: Stage[] = [
  { key: "queued", label: "Queued", icon: "Clock", ramp: 0, hint: "Waiting for a free agent slot" },
  { key: "plan", label: "Plan", icon: "ClipboardList", ramp: 1, hint: "Agent investigates and writes a plan" },
  { key: "build", label: "Build", icon: "Hammer", ramp: 2, hint: "Agent implements and commits" },
  { key: "verify", label: "Verify", icon: "FlaskConical", ramp: 3, hint: "Verify command and/or agent verification" },
  { key: "review", label: "Review", icon: "SearchCheck", ramp: 4, hint: "Independent reviewer or self-review" },
  { key: "ship", label: "Ship", icon: "GitPullRequest", ramp: 5, hint: "Push, pull request, CI, merge" },
  { key: "human", label: "Needs you", icon: "Hand", tone: "warning", hint: "Waiting on a person: a question, a plan to approve, or an escalation" },
];

export const STEP_LABEL: Record<string, string> = { plan: "Plan", build: "Build", verify: "Verify", review: "Review", ship: "Ship", done: "Done" };

type EntryLike = { stage: string; detail: string };

/** The dashboard group an entry belongs to (null for finished items). */
export function stageOf(entry: EntryLike): Stage | null {
  if (entry.detail === "done" || entry.detail === "failed") return null;
  if (entry.detail === "waiting_on_human" || entry.detail === "blocked") return STAGES.find((s) => s.key === "human")!;
  if (entry.detail === "queued") return STAGES.find((s) => s.key === "queued")!;
  return STAGES.find((s) => s.key === entry.stage) ?? null;
}

export function stageColor(stage: Stage, palette: Palette): string {
  if (stage.tone) return STATUS[stage.tone];
  return palette.ramp[stage.ramp ?? 0] ?? palette.accent;
}

/** Stepper positions: the repo's enabled stages, then Done. */
export function steps(entry: { stages: string[] }): string[] {
  return [...entry.stages, "done"];
}

export function stepIndex(entry: { stage: string; stages: string[]; detail: string }): number {
  if (entry.detail === "done") return entry.stages.length;
  const i = entry.stages.indexOf(entry.stage);
  return i >= 0 ? i : 0;
}

export const ACTOR: Record<string, { label: string; icon: string }> = {
  agent: { label: "Agent", icon: "Bot" },
  cos: { label: "Chief of Staff", icon: "Cog" },
  human: { label: "You", icon: "Hand" },
  system: { label: "Retrying", icon: "RefreshCw" },
  none: { label: "", icon: "Circle" },
};
