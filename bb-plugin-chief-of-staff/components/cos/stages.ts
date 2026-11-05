// Pipeline stages shown on the dashboard, grouped from the raw work-item status.
// In-flight stages take the ordinal blue ramp; stages that need attention take a status color.
import type { Palette, Tone } from "./viz";
import { STATUS } from "./viz";

export type StageKey = "queued" | "coding" | "checking" | "review" | "fixing" | "human";

export interface Stage {
  key: StageKey;
  label: string;
  details: string[];
  icon: string;
  ramp?: number;
  tone?: Exclude<Tone, "neutral" | "info">;
  hint: string;
}

export const STAGES: Stage[] = [
  { key: "queued", label: "Queued", details: ["queued"], icon: "Clock", ramp: 0, hint: "Waiting for a free agent slot" },
  { key: "coding", label: "Coding", details: ["running"], icon: "Bot", ramp: 1, hint: "Agent is working in its thread" },
  { key: "checking", label: "Checks", details: ["checking"], icon: "FlaskConical", ramp: 2, hint: "Running the repo's check command" },
  { key: "review", label: "PR open", details: ["pr_open"], icon: "GitPullRequest", ramp: 3, hint: "Pull request open, CI running or green" },
  { key: "fixing", label: "Fixing CI", details: ["ci_failed", "fixing"], icon: "Wrench", tone: "serious", hint: "CI failed; agent is fixing it" },
  { key: "human", label: "Needs you", details: ["waiting_on_human", "blocked"], icon: "Hand", tone: "warning", hint: "Agent stopped and is waiting on a person" },
];

export function stageOf(detail: string): Stage | null {
  return STAGES.find((s) => s.details.includes(detail)) ?? null;
}

export function stageColor(stage: Stage, palette: Palette): string {
  if (stage.tone) return STATUS[stage.tone];
  return palette.ramp[stage.ramp ?? 0] ?? palette.accent;
}

// Progress stepper positions: Queued -> Coding -> Checks -> PR -> Done.
export const STEPS = ["Queued", "Coding", "Checks", "PR", "Done"] as const;

export function stepIndex(detail: string, hasPr: boolean): number {
  switch (detail) {
    case "queued":
      return 0;
    case "running":
      return 1;
    case "checking":
      return 2;
    case "pr_open":
    case "ci_failed":
    case "fixing":
      return 3;
    case "done":
      return 4;
    default:
      return hasPr ? 3 : 1;
  }
}
