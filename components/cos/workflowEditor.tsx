// Workflows editor: the list of workflows (add, duplicate, rename, delete, set
// default), and for the selected one a canvas and a list view of its steps.
// Every step has a name, instructions and arrows to the steps after it; its
// type (agent, check, ship) adds the rest.
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../rpcContract";
import type { KnownSkill } from "../../src/skills";
import { SkillTextarea } from "./skillTextarea";
import {
  DEFAULT_WORKFLOW,
  blankStep,
  descendants,
  newStepId,
  topoOrder,
  validateDocument,
  validateWorkflow,
  type Step,
  type StepType,
  type Workflow,
  type WorkflowsDocument,
} from "../../src/workflow";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { ConfirmRemove, Field, NumberInput, Problems, Select, TextInput, ToggleRow } from "./fields";
import { STEP_TYPE_META, WorkflowCanvas } from "./workflowCanvas";
import { STATUS, StatusPill } from "./viz";

const textareaClass = "min-h-24 w-full rounded-md border border-input bg-transparent p-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function slug(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "workflow";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** Change a step's type, keeping what all types share. */
function retype(step: Step, type: StepType): Step {
  if (step.type === type) return step;
  const fresh = blankStep(type, step.id, step.name);
  return { ...fresh, instructions: step.instructions, next: step.next, position: step.position } as Step;
}

export function WorkflowsEditor({ doc, onChange, usedBy }: { doc: WorkflowsDocument; onChange: (d: WorkflowsDocument) => void; usedBy: Record<string, string[]> }) {
  const [current, setCurrent] = useState(doc.default);
  const [view, setView] = useState<"canvas" | "list">("canvas");
  const [selected, setSelected] = useState<string | null>(null);
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
  const problems = useMemo(() => validateWorkflow(wf), [wf]);
  const docProblems = useMemo(() => validateDocument(doc).filter((p) => !p.startsWith(`${wf.name}: `)), [doc, wf.name]);

  const setWf = (next: Workflow) => onChange({ ...doc, workflows: doc.workflows.map((w) => (w.id === wf.id ? next : w)) });
  const setStep = (id: string, next: Step) => setWf({ ...wf, steps: wf.steps.map((s) => (s.id === id ? next : s)) });
  const removeStep = (id: string) => {
    if (wf.steps.length <= 1) return;
    setWf({ ...wf, steps: wf.steps.filter((s) => s.id !== id).map((s) => ({ ...s, next: s.next.filter((n) => n !== id), ...(s.onFail === id ? { onFail: undefined } : {}) }) as Step) });
    setSelected(null);
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
        A workflow is the path every task takes. Steps run when every step pointing at them is done; steps side by side run in parallel. An <b>Agent</b> step runs agents on its instructions (read-only ones may run several at once), a <b>Check</b> runs a command, <b>Ship</b> pushes, opens or merges the PR. Pass/fail steps, checks and ship can send the work back to an earlier step.
      </p>

      {/* workflows */}
      <div className="flex flex-wrap items-center gap-1.5">
        {doc.workflows.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => {
              setCurrent(w.id);
              setSelected(null);
            }}
            className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm", w.id === wf.id ? "border-foreground/40 bg-state-active font-medium text-foreground" : "border-border text-muted-foreground hover:bg-state-hover")}
          >
            <Icon name="Workflow" fallback="Circle" className="size-3.5" aria-hidden />
            {w.name}
            {w.id === doc.default ? <span className="rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">default</span> : null}
            {validateWorkflow(w).length ? <span aria-label="has problems" className="size-1.5 rounded-full" style={{ background: STATUS.critical }} /> : null}
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
        <Field label="Name" className="min-w-48 flex-1">
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
            label={`Delete ${wf.name}${usedBy[wf.id]?.length ? ` (repos using it fall back to the default)` : ""}`}
            onConfirm={() => {
              onChange({ ...doc, workflows: doc.workflows.filter((w) => w.id !== wf.id) });
              setCurrent(doc.default);
            }}
          />
        ) : null}
        <div className="ml-auto flex rounded-md border border-border p-0.5">
          {(["canvas", "list"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={cn("flex items-center gap-1 rounded px-2 py-1 text-xs", view === v ? "bg-state-active text-foreground" : "text-muted-foreground")}>
              <Icon name={v === "canvas" ? "Network" : "List"} fallback="Circle" className="size-3.5" aria-hidden />
              {v === "canvas" ? "Canvas" : "List"}
            </button>
          ))}
        </div>
      </div>

      <Problems items={[...problems, ...docProblems]} />

      {view === "canvas" ? (
        <div className={cn("grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]", expanded && "fixed inset-0 z-50 grid-rows-[minmax(0,1fr)_auto] bg-background p-3 md:grid-cols-[minmax(0,1fr)_24rem] md:grid-rows-1")}>
          <WorkflowCanvas workflow={wf} onChange={setWf} selected={selected} onSelect={setSelected} expanded={expanded} onToggleExpanded={() => setExpanded((v) => !v)} className={expanded ? "h-full min-h-0" : "h-[520px]"} />
          <div className={cn("min-w-0", expanded && "min-h-0 max-h-[40vh] overflow-y-auto md:max-h-full")}>
            {selected && wf.steps.some((s) => s.id === selected) ? (
              <StepPanel workflow={wf} step={wf.steps.find((s) => s.id === selected)!} onChange={(s) => setStep(selected, s)} onRemove={() => removeStep(selected)} skills={skills} narrow />
            ) : (
              <div className="flex h-full min-h-40 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                <Icon name="MousePointerClick" fallback="Circle" className="size-5" aria-hidden />
                Select a step to edit it. Drag from a step's right edge to another step to run it after. Select an arrow and press Backspace to remove it.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {topoOrder(wf).map((id) => {
            const step = wf.steps.find((s) => s.id === id)!;
            return <StepPanel key={id} workflow={wf} step={step} onChange={(s) => setStep(id, s)} onRemove={() => removeStep(id)} skills={skills} collapsible />;
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

/** Edit one step: the common fields, then its type's fields. */
export function StepPanel({ workflow, step, onChange, onRemove, skills = null, collapsible = false, narrow = false }: { workflow: Workflow; step: Step; onChange: (s: Step) => void; onRemove: () => void; skills?: readonly KnownSkill[] | null; collapsible?: boolean; narrow?: boolean }) {
  const two = narrow ? "grid grid-cols-1 gap-2" : "grid grid-cols-1 gap-2 sm:grid-cols-2";
  const [open, setOpen] = useState(!collapsible);
  const set = (patch: Record<string, unknown>) => onChange({ ...step, ...patch } as Step);
  const meta = STEP_TYPE_META[step.type];
  const others = workflow.steps.filter((s) => s.id !== step.id);
  // Fail arrows may only go back: to this step or a step it comes after.
  const before = others.filter((s) => descendants(workflow, s.id).has(step.id));
  const canFail = step.type !== "agent" || step.verdict;
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3">
      <header className="flex items-center gap-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => collapsible && setOpen(!open)} aria-expanded={open}>
          {collapsible ? <Icon name={open ? "ChevronDown" : "ChevronRight"} fallback="Circle" className="size-4 text-muted-foreground" aria-hidden /> : null}
          <Icon name={meta.icon} fallback="Circle" className="size-4 text-foreground" aria-hidden />
          <span className="truncate text-sm font-semibold text-foreground">{step.name}</span>
          <StatusPill tone="neutral" label={meta.label} />
          {step.next.length ? <span className="truncate text-[11px] text-muted-foreground">→ {step.next.map((n) => workflow.steps.find((s) => s.id === n)?.name ?? n).join(", ")}</span> : null}
        </button>
        {workflow.steps.length > 1 ? <ConfirmRemove label={`Remove ${step.name}`} onConfirm={onRemove} /> : null}
      </header>
      {open ? (
        <>
          <Row narrow={narrow}>
            <Field label="Name">{(id) => <TextInput id={id} value={step.name} onChange={(v) => set({ name: v })} />}</Field>
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
          <Field label={step.type === "agent" ? "Instructions for the agent" : "Notes"} hint={step.type === "agent" ? <>What this step should achieve. Type <code>/</code> to use an agent skill. The agent also gets the reports of the steps before it.</> : "Shown in prompts that follow; optional."}>
            {(id) =>
              step.type === "agent" ? (
                <SkillTextarea id={id} className={textareaClass} value={step.instructions} onChange={(v) => set({ instructions: v })} placeholder="e.g. Investigate the codebase and write a plan… (type / for skills)" skills={skills} />
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
                <Field label="Agents in parallel" hint="Each works independently; their reports are combined.">
                  {(id) => <NumberInput id={id} value={step.agents} min={1} max={4} onChange={(v) => set({ agents: Math.min(4, Math.max(1, v)) })} />}
                </Field>
              ) : null}
            </div>
          ) : null}
          {step.type === "check" ? (
            <Row narrow={narrow}>
              <Field label="Command" hint="Runs in the task's worktree; a non-zero exit fails the check.">{(id) => <TextInput id={id} value={step.command} onChange={(v) => set({ command: v })} placeholder="npm test" mono />}</Field>
              <Field label="Timeout (minutes)">{(id) => <NumberInput id={id} value={step.timeoutMinutes} min={1} max={240} onChange={(v) => set({ timeoutMinutes: v })} />}</Field>
            </Row>
          ) : null}
          {step.type === "ship" ? (
            <div className={two}>
              <Field label="Shipping means">
                {(id) => (
                  <Select
                    id={id}
                    value={step.action}
                    onChange={(v) => set({ action: v })}
                    options={[
                      { value: "pr", label: "Open a pull request; I merge it" },
                      { value: "merge", label: "Open a pull request and merge it when green" },
                      { value: "push", label: "Push the branch only" },
                    ]}
                  />
                )}
              </Field>
              {step.action !== "push" ? <ToggleRow label="Open as draft" checked={step.draft} onChange={(v) => set({ draft: v })} /> : null}
              {step.action === "merge" ? <ToggleRow label="Wait for an approving review" checked={step.requireApproval} onChange={(v) => set({ requireApproval: v })} /> : null}
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
                <Field label={step.type === "agent" ? "Rounds" : "Attempts"} hint="Before asking you.">
                  {(id) => <NumberInput id={id} value={step.type === "agent" ? step.maxRounds : step.maxAttempts} min={0} max={10} onChange={(v) => set(step.type === "agent" ? { maxRounds: v } : { maxAttempts: v })} />}
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
