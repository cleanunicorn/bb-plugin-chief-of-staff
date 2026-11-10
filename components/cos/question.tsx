// Answer-from-dashboard sheet: shows the agent's open question(s) with their
// options, approval decisions, and the context around them (the agent's last
// message, failing checks), then answers through cos_answer or opens the thread.
// Workflow gates (a step waiting for approval, a step out of attempts) get a decision
// block: approve and move on, or send it back to the agent with feedback.
import { useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { Markdown, experimental_useRpcQuery, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../rpcContract";
import type { AnswerPayload, OpenQuestion } from "../../rpcContract";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { Sheet } from "./sheet";
import { DialogClose, DialogTitle } from "../ui/dialog";
import { STATUS } from "./viz";

type Contract = typeof rpcContract;
type QuestionItem = Extract<OpenQuestion, { kind: "question" }>["questions"][number];
type Draft = Record<string, { selected: string[]; freeText: string }>;

const textareaClass =
  "min-h-20 w-full rounded-md border border-input bg-transparent p-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

const SIZE_KEY = "cos.questionSheet.size";
const MIN_W = 420;
const MIN_H = 320;
const MARGIN = 24;
type Size = { w: number; h: number };

function clampSize(size: Size): Size {
  return {
    w: Math.round(Math.min(Math.max(size.w, MIN_W), window.innerWidth - MARGIN * 2)),
    h: Math.round(Math.min(Math.max(size.h, MIN_H), window.innerHeight - MARGIN * 2)),
  };
}

function loadSize(): Size | null {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null") as Partial<Size> | null;
    return raw && typeof raw.w === "number" && typeof raw.h === "number" ? clampSize({ w: raw.w, h: raw.h }) : null;
  } catch {
    return null;
  }
}

/** Width/height the user dragged to (remembered across opens), plus a maximize toggle. */
function useResizableSize() {
  const [size, setSize] = useState<Size | null>(() => (typeof window === "undefined" ? null : loadSize()));
  const [maximized, setMaximized] = useState(false);
  const save = (next: Size | null) => {
    setSize(next);
    try {
      if (next) localStorage.setItem(SIZE_KEY, JSON.stringify(next));
      else localStorage.removeItem(SIZE_KEY);
    } catch {
      /* storage unavailable: size lasts for this open only */
    }
  };
  /** Drag from the corner. The panel is centred, so it grows on both sides: double the delta to keep the corner under the pointer. */
  const startDrag = (e: ReactPointerEvent<HTMLElement>, panel: HTMLElement | null) => {
    if (!panel || e.button !== 0) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    setMaximized(false);
    let latest: Size = { w: rect.width, h: rect.height };
    const move = (ev: PointerEvent) => {
      latest = clampSize({ w: start.w + (ev.clientX - start.x) * 2, h: start.h + (ev.clientY - start.y) * 2 });
      setSize(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      save(latest);
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const resizeBy = (dw: number, dh: number, panel: HTMLElement | null) => {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    setMaximized(false);
    save(clampSize({ w: rect.width + dw, h: rect.height + dh }));
  };
  return { size, maximized, setMaximized, startDrag, resizeBy, reset: () => { setMaximized(false); save(null); } };
}

const DECISION_LABEL = { allow_once: "Allow once", allow_for_session: "Allow for session", deny: "Deny" } as const;

export function QuestionSheet({ itemId, onClose, onAnswered, restoreFocus }: { itemId: string; onClose: () => void; onAnswered: () => void; restoreFocus?: () => void }) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const view = experimental_useRpcQuery<Contract, "cos_question">({ contract: rpcContract, method: "cos_question", input: { id: itemId } });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const resize = useResizableSize();
  const panelStyle: CSSProperties | undefined = resize.maximized
    ? { width: `calc(100vw - ${MARGIN * 2}px)`, height: `calc(100vh - ${MARGIN * 2}px)`, maxWidth: "none", maxHeight: "none" }
    : resize.size
      ? { width: resize.size.w, height: resize.size.h, maxWidth: "none", maxHeight: "none" }
      : undefined;

  const send = async (answer: AnswerPayload, label: string) => {
    setSending(true);
    setError(null);
    try {
      await rpc.call("cos_answer", { id: itemId, answer });
      setSent(label);
      onAnswered();
      await view.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const data = view.data;
  const openThread = () => {
    if (!data?.threadId) return;
    onClose();
    navigate.toThread(data.threadId);
  };

  return (
    <Sheet
      ref={panelRef}
      onClose={onClose}
      restoreFocus={restoreFocus}
      style={panelStyle}
      // A bottom sheet on phones, centred from `sm` up.
      className="top-auto bottom-0 h-[90dvh] max-h-[90dvh] max-w-5xl translate-y-0 gap-0 rounded-t-xl p-0 sm:top-[50%] sm:bottom-auto sm:h-[85vh] sm:w-[calc(100%-3rem)] sm:translate-y-[-50%] sm:rounded-xl"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">
            {data ? `${data.repo}${data.issueNumber ? ` #${data.issueNumber}` : ""}` : "Loading…"}
          </p>
          <DialogTitle className="line-clamp-2 leading-normal tracking-normal text-foreground">
            {data?.issueTitle || "Agent question"}
          </DialogTitle>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="hidden h-7 w-7 p-0 sm:inline-flex"
            aria-label={resize.maximized ? "Restore size" : "Maximize"}
            onClick={() => resize.setMaximized(!resize.maximized)}
          >
            <Icon name={resize.maximized ? "Minimize2" : "Maximize2"} fallback="Square" aria-hidden />
          </Button>
          <DialogClose asChild>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="Close">
              <Icon name="X" fallback="Circle" aria-hidden />
            </Button>
          </DialogClose>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {view.error ? <Notice tone="critical" text={view.error.message} /> : null}
        {!data && !view.error ? <p className="text-sm text-muted-foreground">Reading the thread…</p> : null}
        {sent ? <Notice tone="good" text={`Sent: ${sent}. The agent picks it up from here.`} /> : null}
        {error ? <Notice tone="critical" text={error} /> : null}

        {data ? (
          <>
            {data.decidable && !sent ? <Decision data={data} sending={sending} onSend={send} /> : null}
            {data.open.length === 0 && !sent && !data.decidable ? (
              <p className="text-sm text-muted-foreground">
                {data.waitingReason
                  ? "No open question on the thread right now. It may have been answered in BB, or the item is waiting for another reason (see the context below). You can still send the agent a message."
                  : "The agent is not asking anything right now. You can still send it a message."}
              </p>
            ) : null}
            {data.open.map((q, i) => (
              <OpenQuestionView key={q.kind === "text" ? `text-${i}` : q.interactionId} q={q} sending={sending} onSend={send} />
            ))}
            {!data.decidable && (data.open.length === 0 || data.open.every((q) => q.kind === "request" && !q.answerable)) ? (
              <ReplyBox label="Message the agent" placeholder="Tell the agent what to do next." sending={sending} onSend={(text) => send({ kind: "text", text }, "message")} />
            ) : null}
            {data.report && data.waitingKind === "escalation" ? <Collapsible icon="SearchCheck" title={`${data.stepName ?? "Step"} report`} markdown={data.report} /> : null}
            <Context lastMessage={data.lastMessage} checkOutput={data.checkOutput} lastError={data.lastError} />
          </>
        ) : null}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
        <p className="text-xs text-muted-foreground">{data?.decidable ? "Decisions move the task through its workflow; feedback goes to the agent's thread." : "Answers go straight to the agent's thread."}</p>
        {data?.threadId ? (
          <Button size="sm" variant="outline" onClick={openThread}>
            <Icon name="MessageSquare" fallback="Circle" aria-hidden /> Open thread
          </Button>
        ) : null}
      </footer>
      <div
        role="separator"
        aria-label="Resize (drag, or arrow keys; double-click to reset)"
        aria-orientation="horizontal"
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        className="absolute right-0 bottom-0 hidden size-4 cursor-nwse-resize touch-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:block"
        onPointerDown={(e) => resize.startDrag(e, panelRef.current)}
        onDoubleClick={resize.reset}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 80 : 20;
          const delta = { ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowDown: [0, step], ArrowUp: [0, -step] }[e.key];
          if (!delta) return;
          e.preventDefault();
          resize.resizeBy(delta[0], delta[1], panelRef.current);
        }}
      >
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
          <path d="M14 6 6 14M14 10l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
        </svg>
      </div>
    </Sheet>
  );
}

function Notice({ tone, text }: { tone: "good" | "critical"; text: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground">
      <Icon name={tone === "good" ? "CircleCheck" : "CircleX"} fallback="Circle" className="mt-0.5 size-4 shrink-0" style={{ color: STATUS[tone] }} aria-hidden />
      {text}
    </p>
  );
}

function OpenQuestionView({ q, sending, onSend }: { q: OpenQuestion; sending: boolean; onSend: (answer: AnswerPayload, label: string) => void }) {
  if (q.kind === "question") return <QuestionForm q={q} sending={sending} onSend={onSend} />;
  if (q.kind === "approval") {
    return (
      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <SectionTitle icon="ShieldQuestion" text={`Approval: ${q.subject}`} />
        {q.reason ? <Markdown content={q.reason} className="text-sm text-foreground" /> : null}
        {q.detail ? (
          q.detailMarkdown ? (
            <div className="max-h-80 overflow-auto rounded-md bg-muted p-3">
              <Markdown content={q.detail} className="text-sm text-foreground" />
            </div>
          ) : (
            <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-foreground">{q.detail}</pre>
          )
        ) : null}
        <div className="flex flex-wrap gap-2">
          {q.decisions.map((d) => (
            <Button key={d} size="sm" variant={d === "deny" ? "outline" : "default"} disabled={sending} onClick={() => onSend({ kind: "approval", interactionId: q.interactionId, decision: d }, DECISION_LABEL[d])}>
              {DECISION_LABEL[d]}
            </Button>
          ))}
        </div>
      </section>
    );
  }
  if (q.kind === "request") {
    return (
      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <SectionTitle icon="FileQuestion" text={q.title} />
        {q.detail ? <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-foreground">{q.detail}</pre> : null}
        {q.answerable ? (
          <ReplyBox label="Answer (text or JSON)" placeholder='"yes" or {"key": "value"}' sending={sending} onSend={(value) => onSend({ kind: "request", interactionId: q.interactionId, value }, "answer")} />
        ) : (
          <p className="text-sm text-muted-foreground">This is a form from another plugin. Open the thread to fill it in.</p>
        )}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <SectionTitle icon="MessageCircleQuestion" text="The agent asked" />
      <Markdown content={q.question} className="text-sm text-foreground" />
      <ReplyBox label="Your reply" placeholder="Answer the agent. It continues the thread with your reply." sending={sending} onSend={(text) => onSend({ kind: "text", text }, "reply")} />
    </section>
  );
}

function QuestionForm({ q, sending, onSend }: { q: Extract<OpenQuestion, { kind: "question" }>; sending: boolean; onSend: (answer: AnswerPayload, label: string) => void }) {
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(q.questions.map((x) => [x.id, { selected: [], freeText: "" }])));
  const missing = useMemo(() => q.questions.filter((x) => x.required && !draft[x.id]?.selected.length && !draft[x.id]?.freeText.trim()), [q, draft]);
  const update = (id: string, next: Partial<Draft[string]>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...next } }));
  const submit = () => {
    const answers = Object.fromEntries(
      q.questions
        .filter((x) => draft[x.id].selected.length || draft[x.id].freeText.trim())
        .map((x) => [x.id, draft[x.id].freeText.trim() ? { selected: draft[x.id].selected, freeText: draft[x.id].freeText.trim() } : { selected: draft[x.id].selected }]),
    );
    onSend({ kind: "question", interactionId: q.interactionId, answers }, q.questions.length > 1 ? "answers" : "answer");
  };
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border p-4">
      {q.questions.map((x) => (
        <QuestionField key={x.id} q={x} value={draft[x.id]} onChange={(next) => update(x.id, next)} disabled={sending} />
      ))}
      <div className="flex items-center justify-end gap-2">
        {missing.length ? <span className="text-xs text-muted-foreground">{missing.length === 1 ? "1 answer needed" : `${missing.length} answers needed`}</span> : null}
        <Button size="sm" disabled={sending || missing.length > 0} onClick={submit}>
          <Icon name="Send" fallback="Circle" aria-hidden /> {sending ? "Sending…" : "Send answer"}
        </Button>
      </div>
    </section>
  );
}

function QuestionField({ q, value, onChange, disabled }: { q: QuestionItem; value: Draft[string]; onChange: (next: Partial<Draft[string]>) => void; disabled: boolean }) {
  const toggle = (v: string) => {
    if (q.multiSelect) onChange({ selected: value.selected.includes(v) ? value.selected.filter((s) => s !== v) : [...value.selected, v] });
    else onChange({ selected: value.selected[0] === v ? [] : [v] });
  };
  // A single-select group is one tab stop (the checked option, else the first); arrow keys, Home and End move through it and check.
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const checkedIndex = q.options.findIndex((o) => value.selected.includes(o.value));
  const tabStop = Math.max(checkedIndex, 0);
  const onRadioKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = q.options.length - 1;
    const target: Record<string, number> = { ArrowDown: index === last ? 0 : index + 1, ArrowRight: index === last ? 0 : index + 1, ArrowUp: index === 0 ? last : index - 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last };
    const next = target[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onChange({ selected: [q.options[next]!.value] });
    optionRefs.current[next]?.focus();
  };
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="sr-only">{q.shortLabel ?? q.prompt}</legend>
      <div className="mb-1 text-foreground">
        <Markdown content={q.prompt} className="text-sm font-medium" />
        {q.multiSelect ? <span className="text-xs text-muted-foreground">(pick any)</span> : null}
      </div>
      {q.options.length ? (
        <div className="flex flex-col gap-1.5" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.shortLabel ?? q.prompt}>
          {q.options.map((o, i) => {
            const on = value.selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role={q.multiSelect ? "checkbox" : "radio"}
                aria-checked={on}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                tabIndex={q.multiSelect || i === tabStop ? 0 : -1}
                onKeyDown={q.multiSelect ? undefined : (event) => onRadioKeyDown(event, i)}
                onClick={() => toggle(o.value)}
                className={cn("flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", on ? "border-[color:var(--ring)] bg-muted" : "border-border")}
              >
                <Icon name={on ? (q.multiSelect ? "SquareCheck" : "CircleDot") : q.multiSelect ? "Square" : "Circle"} fallback="Circle" className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{o.label}</span>
                  {o.description ? <Markdown content={o.description} className="block text-xs text-muted-foreground" /> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {q.allowFreeText ? (
        <textarea
          className={cn(textareaClass, q.options.length ? "min-h-14" : "")}
          placeholder={q.options.length ? "Or add your own answer / extra instructions" : "Your answer"}
          value={value.freeText}
          onChange={(e) => onChange({ freeText: e.target.value })}
        />
      ) : null}
    </fieldset>
  );
}

type DecisionData = { stepName: string | null; waitingKind: string | null; waitingReason: string | null; report: string | null };

const DECISION_COPY: Record<string, { title: string; approve: string; back: string; placeholder: string }> = {
  approval: { title: "Approve this step?", approve: "Approve", back: "Send back", placeholder: "What should change?" },
  stalled: { title: "The agent went quiet.", approve: "Treat step as done", back: "Send instructions", placeholder: "What should the agent do next?" },
  escalation: { title: "Out of fix attempts. Your call.", approve: "Continue anyway", back: "Send back to the agent", placeholder: "Instructions for the agent's next attempt." },
  no_report: { title: "The agent stopped without reporting.", approve: "Treat stage as done", back: "Send back to the agent", placeholder: "What should the agent do next?" },
};

/** Approve and move on, or send it back with feedback. */
function Decision({ data, sending, onSend }: { data: DecisionData; sending: boolean; onSend: (answer: AnswerPayload, label: string) => void }) {
  const copy = DECISION_COPY[data.waitingKind ?? ""] ?? DECISION_COPY.escalation!;
  const [feedback, setFeedback] = useState("");
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <SectionTitle icon={data.waitingKind === "approval" ? "ClipboardCheck" : "Hand"} text={data.stepName ? `${data.stepName}: ${copy.title}` : copy.title} />
      {data.waitingKind === "approval" && data.report ? (
        <div className="max-h-[50vh] overflow-auto rounded-md bg-muted px-3 py-2">
          <Markdown content={data.report} className="text-sm text-foreground" />
        </div>
      ) : data.waitingReason ? (
        <p className="text-sm text-foreground">{data.waitingReason}</p>
      ) : null}
      <label className="text-xs font-medium text-muted-foreground">
        Feedback (for sending back)
        <textarea className={cn(textareaClass, "mt-1")} placeholder={copy.placeholder} value={feedback} disabled={sending} onChange={(e) => setFeedback(e.target.value)} />
      </label>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="outline" disabled={sending || !feedback.trim()} onClick={() => onSend({ kind: "revise", feedback: feedback.trim() }, copy.back.toLowerCase())}>
          <Icon name="Undo2" fallback="Circle" aria-hidden /> {copy.back}
        </Button>
        <Button size="sm" disabled={sending} onClick={() => onSend({ kind: "approve" }, copy.approve.toLowerCase())}>
          <Icon name="Check" fallback="Circle" aria-hidden /> {copy.approve}
        </Button>
      </div>
    </section>
  );
}

function Collapsible({ icon, title, markdown }: { icon: string; title: string; markdown: string }) {
  return (
    <details className="rounded-lg border border-border">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
        <Icon name={icon} fallback="Circle" className="size-3.5" aria-hidden /> {title}
      </summary>
      <div className="border-t border-border px-3 py-2">
        <Markdown content={markdown} className="text-sm text-foreground" />
      </div>
    </details>
  );
}

function ReplyBox({ label, placeholder, sending, onSend }: { label: string; placeholder: string; sending: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
        <textarea
          className={cn(textareaClass, "mt-1")}
          placeholder={placeholder}
          value={text}
          disabled={sending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) onSend(text.trim());
          }}
        />
      </label>
      <div className="flex justify-end">
        <Button size="sm" disabled={sending || !text.trim()} onClick={() => onSend(text.trim())}>
          <Icon name="Send" fallback="Circle" aria-hidden /> {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}

function SectionTitle({ icon, text }: { icon: string; text: string }) {
  return (
    <h3 className="flex items-start gap-2 text-sm font-semibold text-foreground">
      <Icon name={icon} fallback="MessageSquare" className="mt-0.5 size-4 shrink-0" style={{ color: STATUS.warning }} aria-hidden />
      <span className="whitespace-pre-wrap">{text}</span>
    </h3>
  );
}

function Context({ lastMessage, checkOutput, lastError }: { lastMessage: string | null; checkOutput: string | null; lastError: string | null }) {
  if (!lastMessage && !checkOutput && !lastError) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Context</h3>
      {lastError ? (
        <p className="flex items-start gap-1.5 text-xs text-foreground">
          <Icon name="CircleAlert" fallback="Circle" className="mt-0.5 size-3.5 shrink-0" style={{ color: STATUS.serious }} aria-hidden />
          {lastError}
        </p>
      ) : null}
      {lastMessage ? (
        <details open className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground">Agent's last message</summary>
          <div className="max-h-[60vh] overflow-auto border-t border-border px-3 py-2">
            <Markdown content={lastMessage} className="text-sm text-foreground" />
          </div>
        </details>
      ) : null}
      {checkOutput ? (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground">Check output</summary>
          <pre className="max-h-64 overflow-auto border-t border-border px-3 py-2 font-mono text-xs whitespace-pre-wrap text-foreground">{checkOutput}</pre>
        </details>
      ) : null}
    </section>
  );
}
