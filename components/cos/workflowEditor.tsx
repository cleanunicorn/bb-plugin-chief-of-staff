// Workflows editor: the list of workflows (add, duplicate, rename, delete, set
// default), and for the selected one a canvas and a list view of its steps.
// Every step has a name, instructions and arrows to the steps after it; its
// type (agent, check, ship) adds the rest.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../rpcContract";
import type { KnownSkill } from "../../src/skills";
import { SkillTextarea } from "./skillTextarea";
import { useRowKeys } from "./rowKeys";
import {
  DEFAULT_MODEL_INSTRUCTIONS,
  DEFAULT_WORKFLOW,
  blankStep,
  modelMode,
  descendants,
  newStepId,
  problemKey,
  problemLine,
  topoOrder,
  workflowProblems,
  type ModelChoice,
  type Step,
  type StepType,
  type Workflow,
  type WorkflowProblem,
  type WorkflowsDocument,
} from "../../src/workflow";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { ConfirmRemove, Field, NumberInput, Select, TextInput, ToggleRow } from "./fields";
import { STEP_TYPE_META, ShrinkGlyph, WorkflowCanvas } from "./workflowCanvas";
import { STATUS, StatusPill } from "./viz";

const textareaClass = "min-h-24 w-full rounded-md border border-input bg-transparent p-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function slug(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "workflow";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

function newChoiceId(taken: string[]): string {
  let n = taken.length + 1;
  while (taken.includes(`choice-${n}`)) n++;
  return `choice-${n}`;
}

/** Change a step's type, keeping what all types share. */
/** The default choosing text is only for an automatic Model step: drop it (unless edited) where nothing chooses. */
const withoutChooserDefault = (instructions: string) => (instructions.trim() === DEFAULT_MODEL_INSTRUCTIONS ? "" : instructions);

function retype(step: Step, type: StepType): Step {
  if (step.type === type) return step;
  const fresh = blankStep(type, step.id, step.name);
  // A new automatic Model step starts with its default choosing text when there is nothing to carry over.
  const instructions = type === "model" && !step.instructions.trim() ? fresh.instructions : withoutChooserDefault(step.instructions);
  return { ...fresh, instructions, next: step.next, position: step.position } as Step;
}

/** A line of the editor's problem list: what to fix, and where activating it goes (nowhere for the document's own problems). */
type ProblemLineItem = { key: string; text: string; workflow?: number; step?: number };

/**
 * The problems to list while workflow `open` is shown: the document's, the open
 * workflow's without its name, and one row per other workflow with problems.
 * The same words in two workflows or steps are two lines.
 */
export function problemLines(doc: WorkflowsDocument, problems: readonly WorkflowProblem[], open: number): ProblemLineItem[] {
  const out: ProblemLineItem[] = [];
  const seen = new Set<string>();
  const others = new Map<number, number>();
  for (const p of problems) {
    const key = problemKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.workflow === undefined) out.push({ key, text: p.text });
    else if (p.workflow === open) out.push({ key, text: problemLine(doc.workflows[open]!, p), workflow: open, step: p.step });
    else others.set(p.workflow, (others.get(p.workflow) ?? 0) + 1);
  }
  for (const [i, n] of others) out.push({ key: `workflow/${i}`, text: `${doc.workflows[i]?.name.trim() || `Workflow ${i + 1}`} · ${n} to fix`, workflow: i });
  return out;
}

/** How many problem lines show before "Show all", so the list cannot push the canvas off a phone screen. */
const SHOWN_PROBLEMS = 3;

/** What to fix before saving. A line about a step selects it; a row for another workflow opens that workflow. */
function ProblemList({ lines, onGo, open }: { lines: ProblemLineItem[]; onGo: (workflow: number, step?: number) => void; open: number }) {
  const [all, setAll] = useState(false);
  if (!lines.length) return null;
  const shown = all ? lines : lines.slice(0, SHOWN_PROBLEMS);
  return (
    <ul data-problem className="flex flex-col gap-1 rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground">
      {shown.map((line) => {
        const icon = <Icon name="CircleX" fallback="Circle" className="mt-px size-3.5 shrink-0" style={{ color: STATUS.critical }} aria-hidden />;
        // A line about the open workflow but no step has nowhere else to go.
        const target = line.workflow !== undefined && (line.step !== undefined || line.workflow !== open);
        return (
          <li key={line.key} className="flex items-start gap-1.5">
            {target ? (
              <button type="button" className="flex items-start gap-1.5 text-left hover:underline" onClick={() => onGo(line.workflow!, line.step)}>
                {icon}
                {line.text}
              </button>
            ) : (
              <>
                {icon}
                {line.text}
              </>
            )}
          </li>
        );
      })}
      {lines.length > SHOWN_PROBLEMS ? (
        <li>
          <button type="button" aria-expanded={all} className="pl-5 text-muted-foreground hover:text-foreground hover:underline" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${lines.length}`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

/** A workflow (by index) and optionally one of its steps to open on. Each new object is applied once. */
export type WorkflowReveal = { workflow: number; step?: number };

/**
 * `usedBy` lists the repositories running each workflow; `onDelete` runs after
 * a workflow is removed from the document, so the caller can detach them.
 * `reveal` opens a workflow and selects a step, e.g. from the save bar while
 * another section was shown (this editor was not mounted then).
 */
export function WorkflowsEditor({ doc, onChange, usedBy, onDelete, problems, reveal }: { doc: WorkflowsDocument; onChange: (d: WorkflowsDocument) => void; usedBy: Record<string, string[]>; onDelete?: (id: string) => void; problems?: WorkflowProblem[]; reveal?: WorkflowReveal }) {
  const [current, setCurrent] = useState(doc.default);
  const [view, setView] = useState<"canvas" | "list">("canvas");
  const [selected, setSelected] = useState<string | null>(null);
  /** The step a problem was opened on: its panel opens, scrolls into view and takes focus, once per `nonce`. */
  const [revealed, setRevealed] = useState<{ id: string; nonce: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);
  // The `/` typeahead is a convenience: without the list, instructions are plain text.
  const skillsQuery = experimental_useRpcQuery<typeof rpcContract, "cos_skills">({ contract: rpcContract, method: "cos_skills", input: null });
  const skills: KnownSkill[] | null = skillsQuery.data?.skills ?? null;
  const wf = doc.workflows.find((w) => w.id === current) ?? doc.workflows[0]!;
  // Everything the server would reject: this workflow's problems and the document's.
  const allProblems = useMemo(() => problems ?? workflowProblems(doc), [doc, problems]);
  const wfIndex = doc.workflows.indexOf(wf);
  const wfProblems = useMemo(() => allProblems.filter((p) => p.workflow === wfIndex), [allProblems, wfIndex]);
  const lines = useMemo(() => problemLines(doc, allProblems, wfIndex), [doc, allProblems, wfIndex]);
  const selectedStep = wf.steps.find((s) => s.id === selected);
  const stepProblems = (step: Step) => {
    const index = wf.steps.indexOf(step);
    return wfProblems.filter((p) => p.step === index);
  };
  /** Problems per step id, for the canvas marks. */
  const problemCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of wfProblems) {
      const id = p.step === undefined ? undefined : wf.steps[p.step]?.id;
      if (typeof id === "string") out[id] = (out[id] ?? 0) + 1;
    }
    return out;
  }, [wfProblems, wf]);

  /** Open workflow `index` and, when given, select step `step` and bring its panel into view. */
  const goTo = (index: number, step?: number) => {
    const target = doc.workflows[index];
    if (!target) return;
    setCurrent(target.id);
    const id = step === undefined ? undefined : target.steps[step]?.id;
    // Set together with the workflow, so the reset a workflow switch does cannot win.
    setSelected(typeof id === "string" ? id : null);
    setRevealed((r) => (typeof id === "string" ? { id, nonce: (r?.nonce ?? 0) + 1 } : null));
  };
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  useEffect(() => {
    if (reveal) goToRef.current(reveal.workflow, reveal.step);
  }, [reveal]);

  const setWf = (next: Workflow) => onChange({ ...doc, workflows: doc.workflows.map((w) => (w.id === wf.id ? next : w)) });
  const setStep = (id: string, next: Step) => setWf({ ...wf, steps: wf.steps.map((s) => (s.id === id ? next : s)) });
  const removeStep = (id: string) => {
    if (wf.steps.length <= 1) return;
    setWf({ ...wf, steps: wf.steps.filter((s) => s.id !== id).map((s) => ({ ...s, next: s.next.filter((n) => n !== id), ...(s.onFail === id ? { onFail: undefined } : {}) }) as Step) });
    setSelected(null);
    setRevealed(null);
  };
  const addWorkflow = (from: Workflow) => {
    const name = from === DEFAULT_WORKFLOW ? "New workflow" : `${from.name} (copy)`;
    const id = slug(name, doc.workflows.map((w) => w.id));
    onChange({ ...doc, workflows: [...doc.workflows, { ...structuredClone(from), id, name }] });
    setCurrent(id);
    setSelected(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        A workflow is the path every task takes. Steps run when every step pointing at them is done; steps side by side run in parallel. An <b>Agent</b> step runs agents on its instructions (read-only ones may run several at once), a <b>Check</b> runs a command, <b>Ship</b> pushes, opens or merges the PR, and a <b>Model</b> step has an agent pick the best model for the steps after it (or sets one you choose). Pass/fail steps, checks and ship can send the work back to an earlier step.
      </p>

      {/* workflows */}
      <div className="flex flex-wrap items-center gap-1.5">
        {doc.workflows.map((w, i) => (
          <button
            key={w.id}
            type="button"
            onClick={() => {
              setCurrent(w.id);
              setSelected(null);
              setRevealed(null);
            }}
            className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm", w.id === wf.id ? "border-foreground/40 bg-state-active font-medium text-foreground" : "border-border text-muted-foreground hover:bg-state-hover")}
          >
            <Icon name="Workflow" fallback="Circle" className="size-3.5" aria-hidden />
            {w.name}
            {w.id === doc.default ? <span className="rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">default</span> : null}
            {allProblems.some((p) => p.workflow === i) ? <span aria-label="has problems" className="size-1.5 rounded-full" style={{ background: STATUS.critical }} /> : null}
          </button>
        ))}
        <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => addWorkflow(DEFAULT_WORKFLOW)}>
          <Icon name="Plus" fallback="Circle" aria-hidden /> New
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => addWorkflow(wf)}>
          <Icon name="Copy" fallback="Circle" aria-hidden /> Duplicate
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3">
        <Field label="Name" className="min-w-48 flex-1" error={wfProblems.find((p) => p.step === undefined && p.field === "name")?.message}>
          {(id) => <TextInput id={id} value={wf.name} onChange={(v) => setWf({ ...wf, name: v })} />}
        </Field>
        <span className="pb-1.5 text-[11px] text-muted-foreground">
          id <code>{wf.id}</code>
          {usedBy[wf.id]?.length ? ` · used by ${usedBy[wf.id]!.join(", ")}` : ""}
        </span>
        {wf.id !== doc.default ? (
          <Button size="sm" variant="outline" className="h-8" onClick={() => onChange({ ...doc, default: wf.id })}>
            <Icon name="Star" fallback="Circle" aria-hidden /> Make default
          </Button>
        ) : null}
        {doc.workflows.length > 1 && wf.id !== doc.default ? (
          <ConfirmRemove
            key={wf.id}
            label={`Delete ${wf.name}`}
            notice={usedBy[wf.id]?.length ? `${usedBy[wf.id]!.join(", ")} will use the default workflow.` : undefined}
            onConfirm={() => {
              onChange({ ...doc, workflows: doc.workflows.filter((w) => w.id !== wf.id) });
              onDelete?.(wf.id);
              setCurrent(doc.default);
            }}
          />
        ) : null}
        <div role="group" aria-label="View" className="ml-auto flex rounded-md border border-border p-0.5">
          {(["canvas", "list"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => {
                setView(v);
                setRevealed(null);
              }} className={cn("flex items-center gap-1 rounded px-2 py-1 text-xs", view === v ? "bg-state-active text-foreground" : "text-muted-foreground")}>
              <Icon name={v === "canvas" ? "Network" : "List"} fallback="Circle" className="size-3.5" aria-hidden />
              {v === "canvas" ? "Canvas" : "List"}
            </button>
          ))}
        </div>
      </div>

      {/* Keyed by workflow, so each one's list starts collapsed. */}
      <ProblemList key={wf.id} lines={lines} onGo={goTo} open={wfIndex} />

      {view === "canvas" ? (
        <div className={cn(expanded && "fixed inset-0 z-50 flex flex-col gap-3 bg-background p-3")}>
          {/* Full screen gets its own bar so the way out is labelled and never sits where the step panel's Remove button is. */}
          {expanded ? (
            <div className="flex shrink-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
              <span className="min-w-0 truncate text-sm text-foreground">
                <span className="text-muted-foreground">Editing workflow</span> <span className="font-semibold">{wf.name}</span>
              </span>
              <span className="ml-auto hidden text-[11px] text-muted-foreground sm:inline">
                Press <kbd className="rounded border border-border px-1 font-mono">Esc</kbd> or
              </span>
              <Button size="sm" variant="outline" className="ml-auto h-8 gap-1.5 sm:ml-0" onClick={() => setExpanded(false)}>
                <ShrinkGlyph /> Exit full screen
              </Button>
            </div>
          ) : null}
          <div className={cn("grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]", expanded && "min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_24rem] md:grid-rows-1")}>
            <WorkflowCanvas workflow={wf} onChange={setWf} selected={selected} onSelect={(id) => { setSelected(id); setRevealed(null); }} problems={problemCounts} reveal={revealed?.nonce} expanded={expanded} onToggleExpanded={() => setExpanded((v) => !v)} className={expanded ? "h-full min-h-0" : "h-[520px]"} />
            <div className={cn("min-w-0", expanded && "min-h-0 max-h-[40vh] overflow-y-auto md:max-h-full")}>
              {selectedStep ? (
                <StepPanel key={selectedStep.id} workflow={wf} step={selectedStep} problems={stepProblems(selectedStep)} reveal={revealed?.id === selectedStep.id ? revealed.nonce : undefined} onChange={(s) => setStep(selectedStep.id, s)} onRemove={() => removeStep(selectedStep.id)} skills={skills} narrow />
              ) : (
                <div className="flex h-full min-h-40 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                  <Icon name="MousePointerClick" fallback="Circle" className="size-5" aria-hidden />
                  Select a step to edit it. Drag from a step's right edge to another step to run it after. Select an arrow and press Backspace to remove it, or change the links under Runs next.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {topoOrder(wf).map((id) => {
            const step = wf.steps.find((s) => s.id === id)!;
            return <StepPanel key={id} workflow={wf} step={step} problems={stepProblems(step)} reveal={revealed?.id === id ? revealed.nonce : undefined} onChange={(s) => setStep(id, s)} onRemove={() => removeStep(id)} skills={skills} collapsible />;
          })}
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(STEP_TYPE_META) as StepType[]).map((t) => (
              <Button
                key={t}
                size="sm"
                variant="outline"
                onClick={() => {
                  const name = `New ${STEP_TYPE_META[t].label.toLowerCase()}`;
                  const last = topoOrder(wf).at(-1);
                  const id = newStepId(wf, name);
                  const steps = wf.steps.map((s) => (s.id === last ? ({ ...s, next: [...s.next, id] } as Step) : s));
                  setWf({ ...wf, steps: [...steps, blankStep(t, id, name)] });
                }}
              >
                <Icon name="Plus" fallback="Circle" aria-hidden /> {STEP_TYPE_META[t].label} step at the end
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return <div className={cn("grid grid-cols-1 gap-3", !narrow && "sm:grid-cols-2")}>{children}</div>;
}

/**
 * Edit one step: the common fields, then its type's fields. `problems` are this step's, shown under their fields.
 * A new `reveal` value opens the panel, scrolls it into view and focuses its heading.
 */
export function StepPanel({ workflow, step, problems = [], reveal, onChange, onRemove, skills = null, collapsible = false, narrow = false }: { workflow: Workflow; step: Step; problems?: WorkflowProblem[]; reveal?: number; onChange: (s: Step) => void; onRemove: () => void; skills?: readonly KnownSkill[] | null; collapsible?: boolean; narrow?: boolean }) {
  const two = narrow ? "grid grid-cols-1 gap-2" : "grid grid-cols-1 gap-2 sm:grid-cols-2";
  const [open, setOpen] = useState(!collapsible);
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!reveal) return;
    setOpen(true);
    // jsdom has no scrollIntoView.
    panel.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    heading.current?.focus({ preventScroll: true });
  }, [reveal]);
  const choiceKeys = useRowKeys<ModelChoice>();
  const set = (patch: Record<string, unknown>) => onChange({ ...step, ...patch } as Step);
  /** The problem with one of this step's fields (or of one of its model choices). */
  const error = (field: string, choice?: number) => problems.find((p) => p.field === field && p.choice === choice)?.message;
  const meta = STEP_TYPE_META[step.type];
  const others = workflow.steps.filter((s) => s.id !== step.id);
  // Fail arrows may only go back: to this step or a step it comes after.
  const before = others.filter((s) => descendants(workflow, s.id).has(step.id));
  const autoModel = step.type === "model" && modelMode(step) === "auto";
  const agentRuns = step.type === "agent" || autoModel;
  const canFail = step.type === "ship" ? step.action === "merge" : step.type === "model" ? false : step.type !== "agent" || step.verdict;
  return (
    <article ref={panel} className="flex scroll-mt-3 flex-col gap-3 rounded-lg border border-border bg-background p-3">
      <header className="flex items-center gap-2">
        <button ref={heading} type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => collapsible && setOpen(!open)} aria-expanded={open}>
          {collapsible ? <Icon name={open ? "ChevronDown" : "ChevronRight"} fallback="Circle" className="size-4 text-muted-foreground" aria-hidden /> : null}
          <Icon name={meta.icon} fallback="Circle" className="size-4 text-foreground" aria-hidden />
          <span className="truncate text-sm font-semibold text-foreground">{step.name}</span>
          <StatusPill tone="neutral" label={meta.label} />
          {collapsible && !open && problems.length ? <StatusPill tone="critical" label={`${problems.length} to fix`} /> : null}
          {step.next.length ? <span className="truncate text-[11px] text-muted-foreground">→ {step.next.map((n) => workflow.steps.find((s) => s.id === n)?.name ?? n).join(", ")}</span> : null}
        </button>
        {workflow.steps.length > 1 ? <ConfirmRemove label={`Remove ${step.name}`} onConfirm={onRemove} /> : null}
      </header>
      {open ? (
        <>
          <Row narrow={narrow}>
            <Field label="Name" error={error("name")}>{(id) => <TextInput id={id} value={step.name} onChange={(v) => set({ name: v })} />}</Field>
            <Field label="Type" hint={meta.hint}>
              {(id) => (
                <Select
                  id={id}
                  value={step.type}
                  onChange={(v) => onChange(retype(step, v))}
                  options={(Object.keys(STEP_TYPE_META) as StepType[]).map((t) => ({ value: t, label: STEP_TYPE_META[t].label }))}
                />
              )}
            </Field>
          </Row>
          {step.type === "model" ? (
            <Field label="How the model is chosen" hint={autoModel ? "An agent reads the task and your instructions, looks at the providers and models available, and picks the best one for the job." : "The agent steps after this one run with the values below."}>
              {(id) => (
                <Select
                  id={id}
                  value={modelMode(step)}
                  onChange={(v) => set({ mode: v, instructions: v === "auto" ? step.instructions.trim() ? step.instructions : DEFAULT_MODEL_INSTRUCTIONS : withoutChooserDefault(step.instructions) })}
                  options={[
                    { value: "auto", label: "Automatically: an agent picks the best model" },
                    { value: "fixed", label: "Fixed: use the model I set" },
                  ]}
                />
              )}
            </Field>
          ) : null}
          <Field
            label={agentRuns ? "Instructions for the agent" : "Notes"}
            error={error("instructions")}
            hint={autoModel ? "How to choose, e.g. what matters for this kind of task. The agent also gets the task and the reports of the steps before it." : agentRuns ? <>What this step should achieve. Type <code>/</code> to use an agent skill. The agent also gets the reports of the steps before it.</> : "Your own notes about this step, optional. No agent sees them."}
          >
            {(id) =>
              agentRuns ? (
                <SkillTextarea id={id} className={textareaClass} value={step.instructions} onChange={(v) => set({ instructions: v })} placeholder={autoModel ? DEFAULT_MODEL_INSTRUCTIONS : "e.g. Investigate the codebase and write a plan… (type / for skills)"} skills={skills} />
              ) : (
                <textarea id={id} className={textareaClass} value={step.instructions} onChange={(e) => set({ instructions: e.target.value })} />
              )
            }
          </Field>

          {step.type === "agent" ? (
            <div className={two}>
              <ToggleRow label="Writes code" hint="Runs in the task's main thread, one code-writing step at a time. Off: read-only, may run in parallel." checked={step.writes} onChange={(v) => set({ writes: v, ...(v ? { agents: 1 } : {}) })} />
              <ToggleRow label="Needs my approval" hint="You approve the report or send it back with feedback." checked={step.approval} onChange={(v) => set({ approval: v })} />
              <ToggleRow label="Pass / fail verdict" hint="The agent reports pass or fail; fail sends the work back." checked={step.verdict} onChange={(v) => set({ verdict: v, ...(v ? {} : { onFail: undefined }) })} />
              {!step.writes ? (
                <Field label="Agents in parallel" hint="Each works independently; their reports are combined." error={error("agents")}>
                  {(id) => <NumberInput id={id} value={step.agents} min={1} max={4} onChange={(v) => set({ agents: v })} />}
                </Field>
              ) : null}
            </div>
          ) : null}
          {step.type === "agent" ? (
            <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-2">
              <p className="text-xs font-medium text-foreground">Choose the model for later steps</p>
              <p className="text-xs text-muted-foreground">
                Add choices and this agent analyses the task and picks one in its report. The agent steps after this one then run with it, until a Model step or another choosing step changes it. Leave empty to not choose.
              </p>
              {step.chooses.map((c, i) => {
                const setChoice = (patch: Record<string, unknown>) => set({ chooses: step.chooses.map((x, j) => (j === i ? choiceKeys.carry(x, { ...x, ...patch }) : x)) });
                return (
                  <div key={choiceKeys.key(c)} className="flex flex-col gap-2 rounded-md border border-border p-2">
                    <div className={two}>
                      <Field label="Choice id" hint="What the agent reports." error={error("id", i)}>{(id) => <TextInput id={id} value={c.id} onChange={(v) => setChoice({ id: v.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40) })} mono />}</Field>
                      <Field label="Use when" error={error("when", i)}>{(id) => <TextInput id={id} value={c.when} onChange={(v) => setChoice({ when: v })} placeholder="e.g. small, well-understood change" />}</Field>
                      <Field label="Agent (provider)" error={error("providerId", i)}>{(id) => <TextInput id={id} value={c.providerId ?? ""} onChange={(v) => setChoice({ providerId: v || undefined })} placeholder="keep current" mono />}</Field>
                      <Field label="Model" error={error("model", i)}>{(id) => <TextInput id={id} value={c.model ?? ""} onChange={(v) => setChoice({ model: v || undefined })} placeholder="keep current" mono />}</Field>
                      <Field label="Reasoning level" error={error("reasoningLevel", i)}>{(id) => <TextInput id={id} value={c.reasoningLevel ?? ""} onChange={(v) => setChoice({ reasoningLevel: v || undefined })} placeholder="keep current" mono />}</Field>
                    </div>
                    <ConfirmRemove label={`Remove choice ${c.id}`} onConfirm={() => set({ chooses: step.chooses.filter((_, j) => j !== i) })} />
                  </div>
                );
              })}
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => set({ chooses: [...step.chooses, { id: newChoiceId(step.chooses.map((c) => c.id)), when: "" }] })}>
                  Add a model choice
                </Button>
                {error("chooses") ? <span className="ml-2 text-[11px]" style={{ color: STATUS.critical }}>{error("chooses")}</span> : null}
              </div>
            </div>
          ) : null}
          {step.type === "model" ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                {autoModel ? "The pick applies to the agent steps after this one" : "Applies to the agent steps after this one"}, and keeps applying until another Model step changes it.{autoModel ? "" : " Empty fields keep the current setting."} Agents already started (such as the code-writing thread of an earlier step) are not changed.
              </p>
            </div>
          ) : null}
          {step.type === "model" && !autoModel ? (
            <div className="flex flex-col gap-2">
              <div className={two}>
                <Field label="Agent (provider)" hint="A BB provider id, e.g. claude-code." error={error("providerId")}>{(id) => <TextInput id={id} value={step.providerId ?? ""} onChange={(v) => set({ providerId: v || undefined, mode: "fixed" })} placeholder="keep current" mono />}</Field>
                <Field label="Model" error={error("model")}>{(id) => <TextInput id={id} value={step.model ?? ""} onChange={(v) => set({ model: v || undefined, mode: "fixed" })} placeholder="keep current" mono />}</Field>
                <Field label="Reasoning level" error={error("reasoningLevel")}>{(id) => <TextInput id={id} value={step.reasoningLevel ?? ""} onChange={(v) => set({ reasoningLevel: v || undefined, mode: "fixed" })} placeholder="keep current" mono />}</Field>
              </div>
            </div>
          ) : null}
          {step.type === "check" ? (
            <Row narrow={narrow}>
              <Field label="Command" hint="Runs in the task's worktree; a non-zero exit fails the check." error={error("command")}>{(id) => <TextInput id={id} value={step.command} onChange={(v) => set({ command: v })} placeholder="npm test" mono />}</Field>
              <Field label="Timeout (minutes)" error={error("timeoutMinutes")}>{(id) => <NumberInput id={id} value={step.timeoutMinutes} min={1} max={240} onChange={(v) => set({ timeoutMinutes: v })} />}</Field>
            </Row>
          ) : null}
          {step.type === "ship" ? (
            <div className={two}>
              <Field label="Shipping means" hint={step.action === "pr" ? "Finishes when the PR opens. Later CI, review and merge are handled by the PR owner." : undefined}>
                {(id) => (
                  <Select
                    id={id}
                    value={step.action}
                    onChange={(v) => set({ action: v })}
                    options={[
                      { value: "pr", label: "Finish when the pull request opens" },
                      { value: "merge", label: "Finish after the pull request is merged" },
                      { value: "push", label: "Push the branch only" },
                    ]}
                  />
                )}
              </Field>
              {step.action !== "push" ? <ToggleRow label="Open as draft" checked={step.draft} onChange={(v) => set({ draft: v })} /> : null}
              {step.action === "merge" ? <ToggleRow label="Wait for an approving review" hint="CI and review waits release task capacity. Merges when approved and green." checked={step.requireApproval} onChange={(v) => set({ requireApproval: v })} /> : null}
            </div>
          ) : null}

          <div className={cn("grid grid-cols-1 gap-3", !narrow && "sm:grid-cols-2")}>
            <Field label="Runs next" hint="Steps that start after this one. Several = they run in parallel.">
              {() => (
                <div className="flex flex-wrap gap-1.5">
                  {others.length ? (
                    others.map((s) => {
                      const on = step.next.includes(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => set({ next: on ? step.next.filter((n) => n !== s.id) : [...step.next, s.id] })}
                          className={cn("rounded-md border px-2 py-0.5 text-xs", on ? "border-foreground/40 bg-state-active text-foreground" : "border-dashed border-border text-muted-foreground")}
                        >
                          {s.name}
                        </button>
                      );
                    })
                  ) : (
                    <span className="text-xs text-muted-foreground">No other steps.</span>
                  )}
                </div>
              )}
            </Field>
            {canFail ? (
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <Field label={step.type === "ship" ? "When CI is red, go back to" : "On fail, go back to"} hint="Re-runs from there with the failure as feedback.">
                  {(id) => (
                    <Select
                      id={id}
                      value={step.onFail ?? ""}
                      onChange={(v) => set({ onFail: v || undefined })}
                      options={[{ value: "", label: "Nowhere: ask me" }, ...before.map((s) => ({ value: s.id, label: s.name }))]}
                    />
                  )}
                </Field>
                <Field label={step.type === "agent" ? "Rounds" : "Attempts"} hint="Before asking you." error={error(step.type === "agent" ? "maxRounds" : "maxAttempts")}>
                  {(id) => <NumberInput id={id} value={step.type === "agent" ? step.maxRounds : step.type === "model" ? 0 : step.maxAttempts} min={0} max={10} onChange={(v) => set(step.type === "agent" ? { maxRounds: v } : { maxAttempts: v })} />}
                </Field>
              </div>
            ) : null}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Step id <code>{step.id}</code> (agents report it). {step.type === "agent" && step.writes ? "Only one code-writing step can run at a time; connect them one after another." : null}
          </p>
        </>
      ) : null}
    </article>
  );
}
