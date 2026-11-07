// Dashboard grouping of work items by who holds the ball. Workflows are user
// defined, so the overview groups by activity rather than by step name; each
// card shows its own workflow's steps.
import type { Palette, Tone } from "./viz";
import { STATUS } from "./viz";

export type StageKey = "queued" | "agent" | "cos" | "pr" | "human";

export interface Stage {
  key: StageKey;
  label: string;
  icon: string;
  ramp?: number;
  tone?: Exclude<Tone, "neutral" | "info">;
  hint: string;
}

export const STAGES: Stage[] = [
  { key: "queued", label: "Queued", icon: "Clock", ramp: 0, hint: "Waiting to start" },
  { key: "agent", label: "Agents working", icon: "Bot", ramp: 2, hint: "An agent is working on a step" },
  { key: "cos", label: "Checks & shipping", icon: "Cog", ramp: 3, hint: "Chief of Staff runs a check, pushes or merges (or retries after an error)" },
  { key: "pr", label: "PR open", icon: "GitPullRequest", ramp: 5, hint: "Pull request open: CI running, or green and ready to merge" },
  { key: "human", label: "Needs you", icon: "Hand", tone: "warning", hint: "A step waits on you: a question, an approval, or a decision" },
];

/** The dashboard group an entry belongs to (null for finished items). */
export function stageOf(entry: { detail: string }): Stage | null {
  const key: StageKey | null = (() => {
    switch (entry.detail) {
      case "done":
      case "failed":
        return null;
      case "waiting_on_human":
      case "blocked":
        return "human";
      case "queued":
        return "queued";
      case "agent":
        return "agent";
      case "ci":
      case "ready":
        return "pr";
      default:
        return "cos";
    }
  })();
  return key ? (STAGES.find((s) => s.key === key) ?? null) : null;
}

export function stageColor(stage: Stage, palette: Palette): string {
  if (stage.tone) return STATUS[stage.tone];
  return palette.ramp[stage.ramp ?? 0] ?? palette.accent;
}

export const ACTOR: Record<string, { label: string; icon: string }> = {
  agent: { label: "Agent", icon: "Bot" },
  cos: { label: "Chief of Staff", icon: "Cog" },
  human: { label: "You", icon: "Hand" },
  system: { label: "Chief of Staff", icon: "RefreshCw" },
  none: { label: "", icon: "Circle" },
};

/** Steps grouped into columns by depth: one column runs in parallel. */
export function columns<T extends { depth: number }>(steps: T[]): T[][] {
  const out: T[][] = [];
  for (const s of steps) (out[s.depth] ??= []).push(s);
  return out.filter(Boolean);
}
