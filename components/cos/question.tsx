// Answer-from-dashboard sheet: shows the agent's open question(s) with their
// options, approval decisions, and the context around them (the agent's last
// message, failing checks), then answers through cos_answer or opens the thread.
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown, experimental_useRpcQuery, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../rpcContract";
import type { AnswerPayload, OpenQuestion } from "../../rpcContract";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { STATUS } from "./viz";

type Contract = typeof rpcContract;
type QuestionItem = Extract<OpenQuestion, { kind: "question" }>["questions"][number];
type Draft = Record<string, { selected: string[]; freeText: string }>;

const textareaClass =
  "min-h-20 w-full rounded-md border border-input bg-transparent p-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

const DECISION_LABEL = { allow_once: "Allow once", allow_for_session: "Allow for session", deny: "Deny" } as const;

export function QuestionSheet({ itemId, onClose, onAnswered }: { itemId: string; onClose: () => void; onAnswered: () => void }) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const view = experimental_useRpcQuery<Contract, "cos_question">({ contract: rpcContract, method: "cos_question", input: { id: itemId } });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cos-question-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-xl border border-border bg-background shadow-lg outline-none sm:rounded-xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              {data ? `${data.repo}${data.issueNumber ? ` #${data.issueNumber}` : ""}` : "Loading…"}
            </p>
            <h2 id="cos-question-title" className="line-clamp-2 text-base font-semibold text-foreground">
              {data?.issueTitle || "Agent question"}
            </h2>
          </div>
          <Button size="sm" variant="ghost" className="h-7 w-7 shrink-0 p-0" aria-label="Close" onClick={onClose}>
            <Icon name="X" fallback="Circle" aria-hidden />
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {view.error ? <Notice tone="critical" text={view.error.message} /> : null}
          {!data && !view.error ? <p className="text-sm text-muted-foreground">Reading the thread…</p> : null}
          {sent ? <Notice tone="good" text={`Sent: ${sent}. The agent picks it up from here.`} /> : null}
          {error ? <Notice tone="critical" text={error} /> : null}

          {data ? (
            <>
              {data.open.length === 0 && !sent ? (
                <p className="text-sm text-muted-foreground">
                  {data.waitingReason
                    ? "No open question on the thread right now. It may have been answered in BB, or the item is waiting for another reason (see the context below). You can still send the agent a message."
                    : "The agent is not asking anything right now. You can still send it a message."}
                </p>
              ) : null}
              {data.open.map((q, i) => (
                <OpenQuestionView key={q.kind === "text" ? `text-${i}` : q.interactionId} q={q} sending={sending} onSend={send} />
              ))}
              {data.open.length === 0 || data.open.every((q) => q.kind === "request" && !q.answerable) ? (
                <ReplyBox label="Message the agent" placeholder="Tell the agent what to do next." sending={sending} onSend={(text) => send({ kind: "text", text }, "message")} />
              ) : null}
              <Context lastMessage={data.lastMessage} checkOutput={data.checkOutput} lastError={data.lastError} />
            </>
          ) : null}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <p className="text-xs text-muted-foreground">Answers go straight to the agent's thread.</p>
          {data?.threadId ? (
            <Button size="sm" variant="outline" onClick={openThread}>
              <Icon name="MessageSquare" fallback="Circle" aria-hidden /> Open thread
            </Button>
          ) : null}
        </footer>
      </div>
    </div>
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
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="sr-only">{q.shortLabel ?? q.prompt}</legend>
      <div className="mb-1 text-foreground">
        <Markdown content={q.prompt} className="text-sm font-medium" />
        {q.multiSelect ? <span className="text-xs text-muted-foreground">(pick any)</span> : null}
      </div>
      {q.options.length ? (
        <div className="flex flex-col gap-1.5" role={q.multiSelect ? "group" : "radiogroup"}>
          {q.options.map((o) => {
            const on = value.selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role={q.multiSelect ? "checkbox" : "radio"}
                aria-checked={on}
                onClick={() => toggle(o.value)}
                className={cn("flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors hover:bg-state-hover", on ? "border-[color:var(--ring)] bg-muted" : "border-border")}
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
          <div className="max-h-96 overflow-auto border-t border-border px-3 py-2">
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
