// Workflow graph on a canvas (React Flow). Edit mode: drag steps, connect a
// step's right handle to another step's left handle to run it after, select an
// arrow and press Backspace to remove it, add steps from the toolbar. Fail
// arrows (“on fail, go back to…”) are drawn dashed and edited in the step
// panel. Read-only mode colours each step by its live status for one task.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ControlButton,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { blankStep, depths, newStepId, topoOrder, type Step, type StepType, type Workflow } from "../../src/workflow";
import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { STATUS } from "./viz";

export type LiveStatus = { status: "pending" | "running" | "waiting" | "done"; phase: string | null; reported: number; agents: number; waitingKind: string | null; retrying: boolean; attempts: number; round: number };

export const STEP_TYPE_META: Record<StepType, { label: string; icon: string; hint: string }> = {
  agent: { label: "Agent", icon: "Bot", hint: "An agent works on the instructions" },
  check: { label: "Check", icon: "FlaskConical", hint: "Chief of Staff runs a command" },
  ship: { label: "Ship", icon: "Rocket", hint: "Push, open a PR, or merge" },
};

const COL = 320;
const ROW = 130;

/** Positions for steps without one: columns by depth, rows within a column. */
export function layout(wf: Workflow, force = false): Map<string, { x: number; y: number }> {
  const depth = depths(wf);
  const perColumn = new Map<number, number>();
  const out = new Map<string, { x: number; y: number }>();
  for (const id of topoOrder(wf)) {
    const s = wf.steps.find((x) => x.id === id)!;
    const d = depth.get(id) ?? 0;
    const row = perColumn.get(d) ?? 0;
    perColumn.set(d, row + 1);
    out.set(id, !force && s.position ? s.position : { x: d * COL, y: row * ROW });
  }
  return out;
}

function subtitle(s: Step): string {
  switch (s.type) {
    case "agent":
      return [s.writes ? "writes code" : "read-only", s.agents > 1 ? `×${s.agents} agents` : null, s.verdict ? "pass/fail" : null, s.approval ? "your approval" : null].filter(Boolean).join(" · ");
    case "check":
      return s.command;
    case "ship":
      return s.action === "merge" ? "PR, merge when green" : s.action === "push" ? "push branch" : "open PR";
  }
}

type StepNodeData = { step: Step; live?: LiveStatus; selected: boolean };

function liveTone(live: LiveStatus | undefined): { color: string; label: string } | null {
  if (!live) return null;
  if (live.status === "done") return { color: STATUS.good, label: "done" };
  if (live.status === "waiting") return { color: live.waitingKind === "cos_error" ? STATUS.serious : STATUS.warning, label: live.waitingKind === "approval" ? "needs approval" : live.waitingKind === "question" ? "question" : "needs you" };
  if (live.status === "running") {
    if (live.retrying) return { color: STATUS.serious, label: "retrying" };
    const progress = live.agents > 1 ? ` ${live.reported}/${live.agents}` : "";
    return { color: "var(--cos-accent, #3b82f6)", label: `${live.phase ?? "running"}${progress}${live.round > 1 ? ` · round ${live.round}` : ""}` };
  }
  return { color: "var(--border)", label: "pending" };
}

function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const { step, live, selected } = data;
  const meta = STEP_TYPE_META[step.type];
  const tone = liveTone(live);
  const active = live?.status === "running";
  return (
    <div
      className={cn("w-52 rounded-lg border bg-card px-3 py-2 text-left shadow-sm", selected ? "ring-2 ring-ring" : "")}
      style={{ borderColor: tone?.color ?? "var(--border)", borderWidth: tone && tone.label !== "pending" ? 2 : 1 }}
    >
      <Handle type="target" position={Position.Left} className="!size-2.5 !border-border !bg-background" />
      <div className="flex items-center gap-1.5">
        <span className="relative inline-flex">
          {active ? <span aria-hidden className="absolute inset-0 animate-ping rounded-full opacity-40" style={{ background: tone?.color }} /> : null}
          <Icon name={meta.icon} fallback="Circle" className="relative size-3.5 text-foreground" aria-hidden />
        </span>
        <span className="truncate text-sm font-semibold text-foreground">{step.name}</span>
      </div>
      <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={subtitle(step)}>
        {subtitle(step)}
      </p>
      {tone ? (
        <p className="mt-1 flex items-center gap-1 text-[11px] font-medium" style={{ color: tone.label === "pending" ? "var(--muted-foreground)" : tone.color }}>
          <span aria-hidden className="size-1.5 rounded-full" style={{ background: tone.color }} />
          {tone.label}
          {live && live.attempts ? <span className="text-muted-foreground"> · {live.attempts} failed</span> : null}
        </p>
      ) : null}
      <Handle type="source" position={Position.Right} className="!size-2.5 !border-border !bg-background" />
      {/* Fail arrows leave and enter at the bottom so they curve under the row instead of hiding behind it. */}
      <Handle type="source" id="fail-out" position={Position.Bottom} isConnectable={false} className="!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-transparent" />
      <Handle type="target" id="fail-in" position={Position.Bottom} isConnectable={false} className="!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-transparent" />
    </div>
  );
}

const nodeTypes = { step: StepNode };

export interface WorkflowCanvasProps {
  workflow: Workflow;
  /** Edit mode when set. */
  onChange?: (wf: Workflow) => void;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  /** Read-only live view: status per step id. */
  live?: Record<string, LiveStatus>;
  className?: string;
  expanded?: boolean;
  onToggleExpanded?: () => void;
}

function CanvasInner({ workflow, onChange, selected = null, onSelect, live, className, expanded, onToggleExpanded }: WorkflowCanvasProps) {
  const editable = Boolean(onChange);
  const positions = useMemo(() => layout(workflow), [workflow]);
  const build = useCallback(
    (): Node<StepNodeData>[] =>
      workflow.steps.map((s) => ({ id: s.id, type: "step", position: positions.get(s.id) ?? { x: 0, y: 0 }, data: { step: s, live: live?.[s.id], selected: s.id === selected }, draggable: editable, selected: s.id === selected })),
    [workflow, positions, live, selected, editable],
  );
  const [nodes, setNodes] = useState<Node<StepNodeData>[]>(build);
  useEffect(() => setNodes(build()), [build]);

  const computedEdges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    // Stagger fail arrows so several going back to the same step do not overlap.
    const failers = workflow.steps.filter((s) => s.onFail).map((s) => s.id);
    const wf_index = (id: string) => failers.indexOf(id);
    for (const s of workflow.steps) {
      for (const n of s.next) out.push({ id: `next:${s.id}:${n}`, source: s.id, target: n, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.5 }, deletable: editable });
      if (s.onFail) {
        out.push({
          id: `fail:${s.id}:${s.onFail}`,
          source: s.id,
          target: s.onFail,
          sourceHandle: "fail-out",
          targetHandle: "fail-in",
          label: s.type === "ship" ? "CI red" : "on fail",
          type: "smoothstep",
          pathOptions: { offset: 24 + 14 * Math.max(0, wf_index(s.id)) },
          animated: true,
          style: { strokeDasharray: "6 4", stroke: STATUS.serious, strokeWidth: 1.5 },
          labelStyle: { fill: STATUS.serious, fontSize: 10 },
          markerEnd: { type: MarkerType.ArrowClosed, color: STATUS.serious },
          deletable: editable,
        } as Edge);
      }
    }
    return out;
  }, [workflow, editable]);
  // Local copy so React Flow can mark an arrow selected (Backspace deletes the selected one).
  const [edges, setEdges] = useState<Edge[]>(computedEdges);
  useEffect(() => setEdges(computedEdges), [computedEdges]);

  const update = useCallback((next: Workflow) => onChange?.(next), [onChange]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<StepNodeData>>[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      if (!editable) return;
      const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
      const moved = changes.filter((c): c is Extract<NodeChange, { type: "position" }> => c.type === "position" && c.dragging === false && Boolean(c.position));
      if (!removed.length && !moved.length) return;
      const steps = workflow.steps
        .filter((s) => !removed.includes(s.id))
        .map((s) => {
          const m = moved.find((c) => c.id === s.id);
          const cleaned = { ...s, next: s.next.filter((n) => !removed.includes(n)), ...(s.onFail && removed.includes(s.onFail) ? { onFail: undefined } : {}) } as Step;
          return m?.position ? ({ ...cleaned, position: { x: Math.round(m.position.x), y: Math.round(m.position.y) } } as Step) : cleaned;
        });
      if (!steps.length) return;
      update({ ...workflow, steps });
      if (removed.includes(selected ?? "")) onSelect?.(null);
    },
    [editable, workflow, update, selected, onSelect],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((es) => applyEdgeChanges(changes.filter((c) => c.type !== "remove"), es));
      if (!editable) return;
      const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
      if (!removed.length) return;
      const steps = workflow.steps.map((s) => {
        const next = s.next.filter((n) => !removed.includes(`next:${s.id}:${n}`));
        const dropFail = s.onFail && removed.includes(`fail:${s.id}:${s.onFail}`);
        return { ...s, next, ...(dropFail ? { onFail: undefined } : {}) } as Step;
      });
      update({ ...workflow, steps });
    },
    [editable, workflow, update],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!editable || !c.source || !c.target || c.source === c.target) return;
      const steps = workflow.steps.map((s) => (s.id === c.source && !s.next.includes(c.target!) ? ({ ...s, next: [...s.next, c.target!] } as Step) : s));
      update({ ...workflow, steps });
    },
    [editable, workflow, update],
  );

  const add = (type: StepType) => {
    const name = `New ${STEP_TYPE_META[type].label.toLowerCase()}`;
    const id = newStepId(workflow, name);
    const maxX = Math.max(0, ...[...positions.values()].map((p) => p.x));
    const step = { ...blankStep(type, id, name), position: { x: maxX + COL, y: 0 } } as Step;
    update({ ...workflow, steps: [...workflow.steps, step] });
    onSelect?.(id);
  };

  const relayout = () => {
    const fresh = layout(workflow, true);
    update({ ...workflow, steps: workflow.steps.map((s) => ({ ...s, position: fresh.get(s.id) }) as Step) });
  };

  return (
    <div className={cn("relative h-[420px] w-full overflow-hidden rounded-lg border border-border bg-background", className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => onSelect?.(n.id)}
        onPaneClick={() => onSelect?.(null)}
        nodesConnectable={editable}
        elementsSelectable
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        colorMode="system"
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false}>
          {onToggleExpanded ? <ControlButton onClick={onToggleExpanded} title={expanded ? "Exit full screen" : "Full screen"} aria-label={expanded ? "Exit full screen" : "Full screen"}><Icon name={expanded ? "Minimize" : "Maximize"} fallback="Square" aria-hidden /></ControlButton> : null}
        </Controls>
      </ReactFlow>
      {editable ? (
        <div className="absolute top-2 left-2 z-10 flex flex-wrap gap-1 rounded-md border border-border bg-card p-1 shadow-sm">
          {(Object.keys(STEP_TYPE_META) as StepType[]).map((t) => (
            <Button key={t} size="sm" variant="ghost" className="h-7 px-2" aria-label={`Add ${STEP_TYPE_META[t].label} step: ${STEP_TYPE_META[t].hint}`} onClick={() => add(t)}>
              <Icon name="Plus" fallback="Circle" aria-hidden /> {STEP_TYPE_META[t].label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Arrange steps by order" onClick={relayout}>
            <Icon name="LayoutGrid" fallback="Circle" aria-hidden /> Tidy
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
