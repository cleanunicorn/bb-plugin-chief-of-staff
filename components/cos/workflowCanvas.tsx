// Workflow graph on a canvas (React Flow). Edit mode: drag steps, connect a
// step's bottom handle to another step's top handle to run it after, select an
// arrow and press Backspace to remove it, add steps from the toolbar. Fail
// arrows (“on fail, go back to…”) are drawn dashed and edited in the step
// panel. Read-only mode colours each step by its live status for one task.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  useReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { blankStep, depths, modelMode, newStepId, topoOrder, type Step, type StepType, type Workflow } from "../../src/workflow";
import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { STATUS } from "./viz";

export type LiveStatus = { status: "pending" | "running" | "waiting" | "done"; phase: string | null; reported: number; agents: number; waitingKind: string | null; retrying: boolean; attempts: number; round: number; picked?: string | null };

export const STEP_TYPE_META: Record<StepType, { label: string; icon: string; hint: string }> = {
  agent: { label: "Agent", icon: "Bot", hint: "An agent works on the instructions" },
  check: { label: "Check", icon: "FlaskConical", hint: "Chief of Staff runs a command" },
  ship: { label: "Ship", icon: "Rocket", hint: "Push, open a PR, or merge" },
  model: { label: "Model", icon: "Settings", hint: "Picks the agent and model for the agent steps after it (automatically, or as you set them), until another Model step changes them" },
};

const COL = 320;
const ROW = 130;

/** Positions for steps without one: rows by depth, columns within a row. */
export function layout(wf: Workflow, force = false): Map<string, { x: number; y: number }> {
  const depth = depths(wf);
  const perRow = new Map<number, number>();
  const out = new Map<string, { x: number; y: number }>();
  for (const id of topoOrder(wf)) {
    const s = wf.steps.find((x) => x.id === id)!;
    const d = depth.get(id) ?? 0;
    const column = perRow.get(d) ?? 0;
    perRow.set(d, column + 1);
    out.set(id, !force && s.position ? s.position : { x: column * COL, y: d * ROW });
  }
  return out;
}

function subtitle(s: Step): string {
  switch (s.type) {
    case "agent":
      return [s.writes ? "writes code" : "read-only", s.agents > 1 ? `×${s.agents} agents` : null, s.chooses.length ? `picks model (${s.chooses.length})` : null, s.verdict ? "pass/fail" : null, s.approval ? "your approval" : null].filter(Boolean).join(" · ");
    case "check":
      return s.command;
    case "model":
      return modelMode(s) === "auto" ? "agent picks the best model" : [s.providerId, s.model, s.reasoningLevel].filter(Boolean).join(" · ") || "not set";
    case "ship":
      return s.action === "merge" ? "finish after merge" : s.action === "push" ? "push branch" : "finish when PR opens";
  }
}

type StepNodeData = { step: Step; live?: LiveStatus; selected: boolean };

/** The step a React Flow selection points at: one step, none (`null`), or `undefined` to leave the current one (an arrow or several steps are selected). */
export function selectionTarget(selection: { nodes: readonly { id: string }[]; edges: readonly { id: string }[] }): string | null | undefined {
  if (selection.nodes.length === 1) return selection.nodes[0]!.id;
  return selection.nodes.length === 0 && selection.edges.length === 0 ? null : undefined;
}

/** Colour and wording for a step's live status; the canvas and the step list share it. */
export function liveTone(live: LiveStatus | undefined): { color: string; label: string } | null {
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
      <Handle type="target" position={Position.Top} className="!size-2.5 !border-border !bg-background" />
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
          {live && live.round > 1 && live.status !== "running" ? <span className="text-muted-foreground"> · {live.round} runs</span> : null}
        </p>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="!size-2.5 !border-border !bg-background" />
      {/* Fail arrows curve around the side of the vertical flow. */}
      <Handle type="source" id="fail-out" position={Position.Right} isConnectable={false} className="!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-transparent" />
      <Handle type="target" id="fail-in" position={Position.Right} isConnectable={false} className="!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-transparent" />
    </div>
  );
}

const nodeTypes = { step: StepNode };
/** Read-only fit: small workflows are not blown up past their natural size. */
const FIT = { padding: 0.15, maxZoom: 1.1 };

export interface WorkflowCanvasProps {
  workflow: Workflow;
  /** Edit mode when set. */
  onChange?: (wf: Workflow) => void;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  /** Read-only live view: status per step id. */
  live?: Record<string, LiveStatus>;
  className?: string;
  /** Full screen is on. The parent shows the way out (a labelled bar), away from the step panel's Remove button. */
  expanded?: boolean;
  /** Shows a labelled "Full screen" button at the canvas's top right while not expanded. */
  onToggleExpanded?: () => void;
  /** Read-only: how often each arrow was taken, by edge id (`next:a:b`, `fail:a:b`); shown from 1 for fail arrows, from 2 otherwise. */
  edgeCounts?: Record<string, number>;
}

function CanvasInner({ workflow, onChange, selected = null, onSelect, live, className, expanded, onToggleExpanded, edgeCounts }: WorkflowCanvasProps) {
  const editable = Boolean(onChange);
  const { fitView } = useReactFlow();
  const positions = useMemo(() => layout(workflow), [workflow]);
  const build = useCallback(
    (): Node<StepNodeData>[] =>
      workflow.steps.map((s) => ({ id: s.id, type: "step", position: positions.get(s.id) ?? { x: 0, y: 0 }, data: { step: s, live: live?.[s.id], selected: s.id === selected }, draggable: editable, selected: s.id === selected, ariaLabel: [s.name, `${STEP_TYPE_META[s.type].label} step`, liveTone(live?.[s.id])?.label].filter(Boolean).join(", ") })),
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
      for (const n of s.next) {
        const times = edgeCounts?.[`next:${s.id}:${n}`] ?? 0;
        out.push({ id: `next:${s.id}:${n}`, source: s.id, target: n, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.5 }, deletable: editable, ...(times > 1 ? { label: `×${times}`, labelStyle: { fontSize: 10 } } : {}) });
      }
      if (s.onFail) {
        const taken = edgeCounts?.[`fail:${s.id}:${s.onFail}`] ?? 0;
        const base = s.type === "ship" ? "CI red" : "on fail";
        out.push({
          id: `fail:${s.id}:${s.onFail}`,
          source: s.id,
          target: s.onFail,
          sourceHandle: "fail-out",
          targetHandle: "fail-in",
          label: taken ? `${base} ×${taken}` : base,
          type: "smoothstep",
          pathOptions: { offset: 24 + 14 * Math.max(0, wf_index(s.id)) },
          animated: true,
          style: { strokeDasharray: "6 4", stroke: STATUS.serious, strokeWidth: taken ? 2.5 : 1.5 },
          labelStyle: { fill: STATUS.serious, fontSize: 10, fontWeight: taken ? 600 : 400 },
          markerEnd: { type: MarkerType.ArrowClosed, color: STATUS.serious },
          deletable: editable,
        } as Edge);
      }
    }
    return out;
  }, [workflow, editable, edgeCounts]);
  // Local copy so React Flow can mark an arrow selected (Backspace deletes the selected one).
  const [edges, setEdges] = useState<Edge[]>(computedEdges);
  useEffect(() => setEdges(computedEdges), [computedEdges]);

  const update = useCallback((next: Workflow) => onChange?.(next), [onChange]);

  // Selection comes from React Flow, so the keyboard (Enter, Space, Escape on a
  // focused step) selects like a click does. React Flow calls this again when
  // the handler changes and once on mount, and `selected` reaches `nodes` one
  // render late, so the handler is stable and only reports a selection React
  // Flow itself changed; otherwise it would undo a step the parent selected.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const reported = useRef<string | null>(null);
  const onSelectionChange = useCallback((selection: { nodes: Node[]; edges: Edge[] }) => {
    const id = selectionTarget(selection);
    if (id === undefined || id === reported.current) return;
    reported.current = id;
    if (id !== selectedRef.current) onSelectRef.current?.(id);
  }, []);

  // Steps are removed from the panel (which asks first), never from the canvas, so a `remove` change
  // is dropped here: the canvas can only lose a step the document has lost.
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<StepNodeData>>[]) => {
      setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== "remove"), ns));
      if (!editable) return;
      const moved = changes.filter((c): c is Extract<NodeChange, { type: "position" }> => c.type === "position" && c.dragging === false && Boolean(c.position));
      if (!moved.length) return;
      const steps = workflow.steps.map((s) => {
        const m = moved.find((c) => c.id === s.id);
        return m?.position ? ({ ...s, position: { x: Math.round(m.position.x), y: Math.round(m.position.y) } } as Step) : s;
      });
      update({ ...workflow, steps });
    },
    [editable, workflow, update],
  );

  // Backspace and Delete listen on the whole document, so a step selected while focus sits on a switch or
  // button in the side panel would be deleted with no confirmation. React Flow also adds every arrow
  // connected to a deleted step to `edges`, so hand back only the arrows the user selected.
  const onBeforeDelete = useCallback(async () => ({ nodes: [], edges: edges.filter((e) => e.selected) }), [edges]);

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
    const maxY = Math.max(0, ...[...positions.values()].map((p) => p.y));
    const step = { ...blankStep(type, id, name), position: { x: 0, y: maxY + ROW } } as Step;
    update({ ...workflow, steps: [...workflow.steps, step] });
    onSelect?.(id);
  };

  // The live view keeps the whole workflow in view as the sheet resizes (full screen, side panel, window).
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = frame.current;
    if (editable || !el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => void fitView(FIT));
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [editable, fitView]);

  const relayout = () => {
    const fresh = layout(workflow, true);
    update({ ...workflow, steps: workflow.steps.map((s) => ({ ...s, position: fresh.get(s.id) }) as Step) });
  };

  return (
    <div className={cn("relative flex h-[420px] w-full flex-col overflow-hidden rounded-lg border border-border bg-background", className)}>
      {/* On phones the add-step toolbar sits above the canvas instead of covering its nodes. */}
      {editable ? (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-border bg-card p-1 sm:absolute sm:top-2 sm:left-2 sm:z-10 sm:rounded-md sm:border sm:shadow-sm">
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
      <div ref={frame} className="relative min-h-0 flex-1">
        {onToggleExpanded && !expanded ? (
          <Button size="sm" variant="outline" className="absolute top-2 right-2 z-10 h-7 gap-1.5 bg-card px-2 shadow-sm" onClick={onToggleExpanded}>
            <ExpandGlyph /> Full screen
          </Button>
        ) : null}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={onSelectionChange}
          nodesConnectable={editable}
          // Arrows can only be removed, so they are tab stops in the editor only.
          edgesFocusable={editable}
          elementsSelectable
          onBeforeDelete={onBeforeDelete}
          deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
          colorMode="system"
          fitView
          fitViewOptions={editable ? { padding: 0.2 } : FIT}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} />
          {/* React Flow's own fit-view glyph is the corner frame people read as "full screen"; use a crosshair instead. */}
          <Controls showInteractive={false} showFitView={false}>
            <ControlButton onClick={() => void fitView({ padding: 0.2, duration: 200 })} title="Fit all steps in view" aria-label="Fit all steps in view">
              <FitGlyph />
            </ControlButton>
          </Controls>
        </ReactFlow>
      </div>
    </div>
  );
}

// Inline stroke icons: React Flow's control CSS fills every svg with currentColor, which turns stroke-only
// host icons into solid squares, so these turn the fill off themselves.
const glyph = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", style: { fill: "none", maxWidth: 14, maxHeight: 14 }, "aria-hidden": true } as const;

/** Crosshair: centre the whole graph. */
function FitGlyph() {
  return (
    <svg {...glyph}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

/** Arrows pointing out to the corners: full screen. */
export function ExpandGlyph() {
  return (
    <svg {...glyph}>
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}

/** Arrows pointing in from the corners: leave full screen. */
export function ShrinkGlyph() {
  return (
    <svg {...glyph}>
      <path d="M14 10h6M14 10V4M14 10l7-7M10 14H4M10 14v6M10 14l-7 7" />
    </svg>
  );
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
