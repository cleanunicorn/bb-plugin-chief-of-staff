// Answer an agent's question from the dashboard. cos_question reads the
// open interactions on a work item's thread (or the plain-text question the
// agent ended its turn with) plus surrounding context; cos_answer resolves the
// interaction through bb.sdk.threads.interactions.resolve, or sends a reply
// message for plain-text questions.
import type { Cos } from "./context";
import type { WorkItem } from "./state";
import { handleActive, syncItem } from "./sync";
import { lastAssistantText, plainTextQuestion, sendToThread, threadUrl } from "./threads";

const CONTEXT_MAX = 6000;
const DETAIL_MAX = 4000;

export interface QuestionOption {
  label: string;
  value: string;
  description: string | null;
}

export type OpenQuestion =
  | {
      kind: "question";
      interactionId: string;
      questions: { id: string; prompt: string; shortLabel: string | null; options: QuestionOption[]; allowFreeText: boolean; multiSelect: boolean; required: boolean }[];
    }
  | { kind: "approval"; interactionId: string; subject: string; reason: string | null; detail: string | null; decisions: ("allow_once" | "allow_for_session" | "deny")[] }
  | { kind: "request"; interactionId: string; title: string; detail: string | null; answerable: boolean }
  | { kind: "text"; question: string };

export interface QuestionView {
  itemId: string;
  repo: string;
  issueNumber: number | null;
  issueTitle: string;
  threadId: string | null;
  threadUrl: string | null;
  status: string;
  waitingReason: string | null;
  open: OpenQuestion[];
  /** The agent's last message, tail-trimmed. */
  lastMessage: string | null;
  /** Check or CI output when the item is waiting because checks failed. */
  checkOutput: string | null;
  lastError: string | null;
}

type Payload = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const tail = (text: string | null, max: number): string | null => (text && text.length > max ? `…${text.slice(text.length - max + 1)}` : text);
const head = (text: string | null, max: number): string | null => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Normalize one pending interaction into something the UI can render. */
export function toOpenQuestion(interaction: { id: string; payload?: unknown }): OpenQuestion {
  const payload = (interaction.payload ?? {}) as Payload;
  const kind = str(payload.kind) ?? "";
  if (kind === "user_question" && Array.isArray(payload.questions)) {
    return {
      kind: "question",
      interactionId: interaction.id,
      questions: (payload.questions as Payload[]).map((q, i) => ({
        id: str(q.id) ?? String(i),
        prompt: str(q.prompt) ?? "",
        shortLabel: str(q.shortLabel),
        options: Array.isArray(q.options)
          ? (q.options as Payload[]).map((o) => ({ label: str(o.label) ?? String(o.value ?? ""), value: typeof o.value === "string" ? o.value : String(o.label ?? ""), description: str(o.description) }))
          : [],
        allowFreeText: q.allowFreeText !== false,
        multiSelect: q.multiSelect === true,
        required: q.required !== false,
      })),
    };
  }
  if (kind === "approval") {
    const subject = (payload.subject ?? {}) as Payload;
    const subjectKind = str(subject.kind) ?? "action";
    let label = subjectKind.replace(/_/g, " ");
    let detail: string | null = null;
    if (subjectKind === "command") {
      label = "run a command";
      detail = [str(subject.command), str(subject.cwd) ? `in ${str(subject.cwd)}` : null].filter(Boolean).join("\n") || null;
    } else if (subjectKind === "file_change") {
      label = "change files";
      detail = str(subject.writeScope);
    } else if (subjectKind === "permission_grant") {
      label = "grant permissions";
      detail = JSON.stringify(subject.permissions ?? {}, null, 2);
    } else if (subjectKind === "plan") {
      label = "approve a plan";
      detail = str(subject.plan);
    } else if (subjectKind === "tool_use") {
      const presentation = (subject.presentation ?? {}) as Payload;
      label = `use ${str(subject.tool) ?? "a tool"}`;
      detail = [str(presentation.title), str(presentation.detail)].filter(Boolean).join("\n") || null;
    }
    const decisions = Array.isArray(payload.availableDecisions)
      ? (payload.availableDecisions as unknown[]).filter((d): d is "allow_once" | "allow_for_session" | "deny" => d === "allow_once" || d === "allow_for_session" || d === "deny")
      : ["allow_once", "deny"] as ("allow_once" | "deny")[];
    return { kind: "approval", interactionId: interaction.id, subject: label, reason: str(payload.reason), detail: head(detail, DETAIL_MAX), decisions };
  }
  // Plugin forms and namespaced requests: show what we can, answer in the thread.
  const presentation = (payload.presentation ?? {}) as Payload;
  const title = str(payload.title) ?? str(presentation.detail) ?? "The agent is waiting for input";
  const data = payload.data === undefined ? null : head(JSON.stringify(payload.data, null, 2), DETAIL_MAX);
  // A namespaced request ("ns/name") accepts a JSON value; plugin forms need their own UI.
  return { kind: "request", interactionId: interaction.id, title, detail: data, answerable: kind !== "plugin" && kind.includes("/") };
}

async function openInteractions(cos: Cos, threadId: string) {
  const list = await cos.bb.sdk.threads.interactions.list({ threadId });
  return list.filter((i) => i.status === "pending");
}

export async function getQuestion(cos: Cos, itemId: string): Promise<QuestionView> {
  const item = cos.store.getWorkItem(itemId);
  if (!item) throw new Error(`work item ${itemId} not found`);
  let open: OpenQuestion[] = [];
  let lastMessage: string | null = null;
  if (item.threadId) {
    try {
      open = (await openInteractions(cos, item.threadId)).map(toOpenQuestion);
    } catch {
      open = [];
    }
    lastMessage = await lastAssistantText(cos, item.threadId);
    if (!open.length) {
      const question = plainTextQuestion(lastMessage);
      if (question) open = [{ kind: "text", question: question.replace(/^Question:\s*/, "") }];
    }
  }
  return {
    itemId: item.id,
    repo: item.repo,
    issueNumber: item.issueNumber,
    issueTitle: item.issueTitle,
    threadId: item.threadId,
    threadUrl: item.threadId ? threadUrl(cos, item.threadId) : null,
    status: item.status,
    waitingReason: item.waitingReason,
    open,
    lastMessage: tail(lastMessage, CONTEXT_MAX),
    checkOutput: tail(item.checkOutput, DETAIL_MAX),
    lastError: item.lastError,
  };
}

export type AnswerInput =
  | { kind: "question"; interactionId: string; answers: Record<string, { selected: string[]; freeText?: string }> }
  | { kind: "approval"; interactionId: string; decision: "allow_once" | "allow_for_session" | "deny" }
  | { kind: "request"; interactionId: string; value: string }
  | { kind: "text"; text: string };

/** Answer the agent and move the item back in step with its thread. */
export async function answerQuestion(cos: Cos, itemId: string, answer: AnswerInput, actor: string): Promise<{ status: string }> {
  const item = cos.store.getWorkItem(itemId);
  if (!item) throw new Error(`work item ${itemId} not found`);
  if (!item.threadId) throw new Error("this item has no thread to answer");
  const threadId = item.threadId;

  let summary: string;
  if (answer.kind === "text") {
    const text = answer.text.trim();
    if (!text) throw new Error("the reply is empty");
    await sendToThread(cos, threadId, text);
    summary = "replied in the thread";
  } else {
    const pending = await openInteractions(cos, threadId);
    const target = pending.find((i) => i.id === answer.interactionId);
    if (!target) throw new Error("that question is no longer open (it may have been answered in the thread)");
    const open = toOpenQuestion(target);
    if (answer.kind === "question") {
      if (open.kind !== "question") throw new Error("that interaction is not a question");
      for (const q of open.questions) {
        const given = answer.answers[q.id];
        const hasAnswer = !!given && (given.selected.length > 0 || !!given.freeText?.trim());
        if (q.required && !hasAnswer) throw new Error(`"${q.shortLabel ?? q.prompt}" needs an answer`);
        if (given && !q.allowFreeText && given.freeText?.trim()) throw new Error(`"${q.shortLabel ?? q.prompt}" does not accept free text`);
        if (given && !q.multiSelect && given.selected.length > 1) throw new Error(`"${q.shortLabel ?? q.prompt}" takes one option`);
        const allowed = new Set(q.options.map((o) => o.value));
        if (given?.selected.some((v) => !allowed.has(v))) throw new Error(`unknown option for "${q.shortLabel ?? q.prompt}"`);
      }
      const answers = Object.fromEntries(
        open.questions
          .filter((q) => answer.answers[q.id])
          .map((q) => {
            const given = answer.answers[q.id];
            const freeText = given.freeText?.trim();
            return [q.id, freeText ? { selected: given.selected, freeText } : { selected: given.selected }];
          }),
      );
      await cos.bb.sdk.threads.interactions.resolve({ threadId, interactionId: target.id, resolution: { kind: "user_answer", answers } });
      summary = "answered the agent's question";
    } else if (answer.kind === "approval") {
      if (open.kind !== "approval") throw new Error("that interaction is not an approval");
      if (!open.decisions.includes(answer.decision)) throw new Error(`"${answer.decision}" is not offered for this approval`);
      const resolution = answer.decision === "deny" ? { decision: "deny" as const } : { decision: answer.decision, grantedPermissions: null };
      await cos.bb.sdk.threads.interactions.resolve({ threadId, interactionId: target.id, resolution });
      summary = `${answer.decision === "deny" ? "denied" : answer.decision === "allow_for_session" ? "allowed for the session" : "allowed once"}: ${open.subject}`;
    } else {
      if (open.kind !== "request" || !open.answerable) throw new Error("answer this request in the thread");
      let value: unknown;
      try {
        value = JSON.parse(answer.value);
      } catch {
        value = answer.value;
      }
      await cos.bb.sdk.threads.interactions.resolve({ threadId, interactionId: target.id, resolution: { kind: "request_answer", value: value as never } });
      summary = `answered request "${open.title}"`;
    }
  }

  // Never log the answer content; it may contain anything the operator typed.
  cos.store.log({ level: "info", kind: "answer", repo: item.repo, workItemId: item.id, message: summary, actor });
  await resync(cos, item, actor);
  cos.invalidate();
  return { status: cos.store.getWorkItem(itemId)?.status ?? item.status };
}

/** After answering, the thread either resumes or asks the next question. */
async function resync(cos: Cos, item: WorkItem, actor: string): Promise<void> {
  const fresh = cos.store.getWorkItem(item.id) ?? item;
  try {
    const remaining = fresh.threadId ? await openInteractions(cos, fresh.threadId) : [];
    if (remaining.length) {
      await syncItem(cos, fresh, actor);
      return;
    }
  } catch {
    /* fall through: treat as resumed */
  }
  await handleActive(cos, fresh, actor);
}
