import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../rpcContract";

type RosterStep = PluginRpcResult<typeof rpcContract["cos_roster"]>["entries"][number]["steps"][number];
import { columns } from "./stages";
import { STATUS, usePalette } from "./viz";

function stepColor(st: RosterStep, palette: ReturnType<typeof usePalette>): string {
  if (st.status === "done") return STATUS.good;
  if (st.status === "waiting") return st.waitingKind === "cos_error" ? STATUS.serious : STATUS.warning;
  if (st.status === "running") return st.retrying ? STATUS.serious : palette.accent;
  return "var(--border)";
}

/** Depth groups follow workflow order; steps within a group can run in parallel. */
export function StepFlow({ entry }: { entry: { workflowName: string; steps: RosterStep[] } }) {
  const palette = usePalette();
  const cols = columns(entry.steps);
  return (
    <ol className="m-0 flex min-w-0 list-none flex-wrap items-center gap-1 p-0" aria-label={`Workflow ${entry.workflowName}`}>
      {cols.map((col, i) => (
        <li key={i} className="flex max-w-full min-w-0 items-center gap-1">
          <ul className="m-0 flex min-w-0 list-none flex-col items-start gap-0.5 p-0" aria-label={col.length > 1 ? `Parallel steps, stage ${i + 1}` : `Stage ${i + 1}`}>
            {col.map((st) => {
              const color = stepColor(st, palette);
              const live = st.status === "running" || st.status === "waiting";
              return (
                <li
                  key={st.id}
                  className={cn("max-w-full rounded-xl border px-1.5 py-px text-[10px] [overflow-wrap:anywhere]", live ? "font-semibold text-foreground" : st.status === "done" ? "text-foreground" : "text-muted-foreground")}
                  style={{ borderColor: color, background: st.status === "done" ? "color-mix(in srgb, var(--cos-good, #16a34a) 8%, transparent)" : undefined }}
                >
                  {st.status === "done" ? <Icon name="Check" fallback="Circle" className="mr-1 inline size-2.5" style={{ color }} aria-hidden /> : <span aria-hidden className={cn("mr-1 inline-block size-1.5 rounded-full", st.status === "running" && "animate-pulse")} style={{ background: color }} />}
                  <span>{st.name}</span>{" · "}<span>{st.retrying && st.status === "running" ? "Retrying" : st.status[0]!.toUpperCase() + st.status.slice(1)}</span>
                  {st.phase ? <span> ({st.phase})</span> : null}
                  {st.agents > 1 && live ? <span className="tabular-nums"> · {st.reported}/{st.agents} agents</span> : null}
                  {st.attempts ? <span> · failed {st.attempts}×</span> : null}
                </li>
              );
            })}
          </ul>
          {i < cols.length - 1 ? <Icon name="ChevronRight" fallback="Circle" className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
        </li>
      ))}
    </ol>
  );
}
