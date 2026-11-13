import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../rpcContract";
import { columns } from "./stages";
import { STATUS, usePalette, type Palette } from "./viz";

type RosterStep = PluginRpcResult<typeof rpcContract["cos_roster"]>["entries"][number]["steps"][number];
type FlowStep = Pick<RosterStep, "id" | "name" | "status" | "retrying" | "waitingKind" | "phase" | "agents" | "reported" | "attempts">;
type StepState = "done" | "running" | "retrying" | "waiting" | "pending";

function stateOf(step: Pick<FlowStep, "status" | "retrying">): StepState {
  return step.status === "running" && step.retrying ? "retrying" : step.status;
}

const LABEL: Record<StepState, string> = { done: "Done", running: "Running", retrying: "Retrying", waiting: "Waiting", pending: "Pending" };

function stepColor(step: Pick<FlowStep, "status" | "retrying" | "waitingKind">, palette: Palette): string {
  const state = stateOf(step);
  if (state === "done") return STATUS.good;
  if (state === "waiting") return step.waitingKind === "cos_error" ? STATUS.serious : STATUS.warning;
  if (state === "retrying") return STATUS.serious;
  if (state === "running") return palette.accent;
  return "var(--border)";
}

/** Status node: the glyph, not only the color, tells the states apart. */
function StepNode({ step, color }: { step: FlowStep; color: string }) {
  const state = stateOf(step);
  if (state === "pending") return <span aria-hidden className="size-4 shrink-0 rounded-full border-[1.5px] border-dashed bg-card" style={{ borderColor: "var(--muted-foreground)", opacity: 0.6 }} />;
  if (state === "done") return <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-full text-white" style={{ background: color }}>
    <Icon name="Check" fallback="Circle" className="size-2.5" />
  </span>;
  if (state === "running") return <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] bg-card" style={{ borderColor: color }}>
    <span className="size-1.5 animate-pulse rounded-full" style={{ background: color }} />
  </span>;
  return <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] bg-card" style={{ borderColor: color, color }}>
    <Icon name={state === "retrying" ? "RefreshCw" : "Hand"} fallback="Circle" className="size-2.5" />
  </span>;
}

function StepRow({ step, palette }: { step: FlowStep; palette: Palette }) {
  const color = stepColor(step, palette);
  const state = stateOf(step);
  const live = state === "running" || state === "retrying" || state === "waiting";
  const details = [
    step.phase,
    step.agents > 1 && live ? `${step.reported}/${step.agents} agents` : null,
    step.attempts ? `failed ${step.attempts}×` : null,
  ].filter(Boolean);
  return (
    <li className="flex min-w-0 items-start gap-2 py-0.5">
      <StepNode step={step} color={color} />
      <span className="min-w-0 flex-1 leading-4">
        <span className={cn("[overflow-wrap:anywhere]", live ? "font-semibold text-foreground" : state === "done" ? "text-foreground" : "text-muted-foreground")}>{step.name}</span>
        {details.length ? <span className="block text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{details.join(" · ")}</span> : null}
      </span>
      {/* Pending is the default: the dashed node says it, the label only adds noise. */}
      <span className={cn("shrink-0 leading-4", live ? "font-medium" : "text-muted-foreground", state === "pending" && "sr-only")} style={live ? { color: state === "running" ? palette.accent : "var(--foreground)" } : undefined}>
        {LABEL[state]}
      </span>
    </li>
  );
}

/**
 * Vertical step list in workflow order. Steps that share a stage run in
 * parallel and are boxed together.
 */
export function StepFlow({ entry }: { entry: { workflowName: string; steps: (FlowStep & { depth: number })[] } }) {
  const palette = usePalette();
  const cols = columns(entry.steps);
  return (
    <ol className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0" aria-label={`Workflow ${entry.workflowName}`}>
      {cols.map((col, i) => (
        <li key={i} className="min-w-0">
          {col.length > 1 ? (
            <div className="-mx-1.5 rounded-md bg-muted/60 px-1.5 py-1">
              <span className="block pb-0.5 pl-6 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">In parallel</span>
              <ul className="m-0 flex list-none flex-col p-0" aria-label={`Parallel steps, stage ${i + 1}`}>
                {col.map((st) => <StepRow key={st.id} step={st} palette={palette} />)}
              </ul>
            </div>
          ) : (
            <ul className="m-0 list-none p-0" aria-label={`Stage ${i + 1}`}>
              <StepRow step={col[0]!} palette={palette} />
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * One segment per step, in workflow order. Each segment is a recorded step
 * state, never an estimate of time remaining, so it is not a progressbar.
 */
export function StepProgress({ steps }: { steps: Pick<FlowStep, "id" | "name" | "status" | "retrying" | "waitingKind">[] }) {
  const palette = usePalette();
  return <span aria-hidden className="flex h-1.5 min-w-0 flex-1 items-stretch gap-0.5">
    {steps.map((step) => {
      const state = stateOf(step);
      return <span
        key={step.id}
        title={`${step.name}: ${LABEL[state].toLowerCase()}`}
        className={cn("min-w-0.5 flex-1 rounded-full", state === "running" && "animate-pulse")}
        style={{ background: state === "pending" ? "var(--border)" : stepColor(step, palette) }}
      />;
    })}
  </span>;
}
