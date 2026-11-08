// Correlate a report with a persisted delivery, never with a thread's busy status.
import { isPromptDeliveryRetry } from "./machine";
import type { Cos } from "./context";
import type { WorkItem } from "./state";
import type { AgentStep } from "./workflow";
import { dispatchLocked, withItemLock } from "./delivery";

export function deliveryWait(item: WorkItem, step: string): boolean {
  const node = item.nodes[step];
  return node?.status === "waiting" && node.waiting?.kind === "cos_error" && isPromptDeliveryRetry(node.retry) && node.retry?.effect.type === "agent" && node.retry.effect.step === step;
}

/** Caller holds the item lock. A token is mandatory when transport acceptance is unknown. */
export function reportMatches(cos: Cos, item: WorkItem, step: AgentStep, agent: number, threadId: string, token?: string): boolean {
  const node = item.nodes[step.id];
  const row = cos.store.getThread(threadId);
  const attempt = node?.deliveries?.[agent];
  if (!node || agent < 0 || agent >= step.agents) return false;
  if (node.status === "waiting" && node.waiting?.kind === "cos_error" && !deliveryWait(item, step.id)) return false;
  if (attempt) {
    if (attempt.round !== node.round || attempt.threadId !== threadId || (token && token !== attempt.id)) return false;
    if (attempt.state !== "accepted") return token === attempt.id;
    if (node.round > 1 && token !== attempt.id) return false;
  }
  return !!row && row.itemId === item.id && row.round === node.round && (!row.stepId || row.stepId === step.id) && row.agent === agent;
}

/** A validated report proves delivery. Leave sibling retries and reports intact. */
export async function acknowledgeReport(cos: Cos, item: WorkItem, step: AgentStep, agent: number, threadId: string): Promise<void> {
  const node = item.nodes[step.id];
  const attempt = node.deliveries?.[agent];
  if (attempt) {
    cos.store.transaction(() => {
      node.deliveries = { ...node.deliveries, [agent]: { ...attempt, state: "accepted" } };
      cos.store.updateWorkItem(item.id, { nodes: item.nodes });
      const row = cos.store.getThread(threadId);
      cos.store.upsertThread({ threadId, itemId: item.id, role: step.writes ? "builder" : "step", stepId: step.id, agent, environmentId: row?.environmentId ?? item.environmentId, round: node.round, promptSentAt: attempt.sentAt });
    });
  }
  await dispatchLocked(cos, item.id, { type: "delivery_ack", step: step.id, agent, round: node.round }, `report:${threadId}`);
}

/** A spawn can create the thread before its response is lost. Match plugin-owned metadata. */
export async function recoverSpawn(cos: Cos, threadId: string): Promise<WorkItem | null> {
  if (cos.store.getWorkItemByThread(threadId)) return cos.store.getWorkItemByThread(threadId);
  let metadata;
  try { metadata = await cos.bb.sdk.threads.getPluginMetadata({ threadId }); }
  catch { return null; }
  if (typeof metadata.workItemId !== "string" || typeof metadata.step !== "string" || typeof metadata.agent !== "number") return null;
  return withItemLock(metadata.workItemId, async () => {
    const item = cos.store.getWorkItem(metadata.workItemId as string);
    const step = item?.workflow.steps.find((s) => s.id === metadata.step);
    if (!item || item.status === "done" || item.status === "failed" || step?.type !== "agent") return null;
    const agent = metadata.agent as number;
    const node = item.nodes[step.id];
    const attempt = node?.deliveries?.[agent];
    if (!attempt || (attempt.threadId && attempt.threadId !== threadId) || attempt.id !== metadata.delivery || attempt.round !== node.round || metadata.round !== node.round || (node.status !== "running" && !deliveryWait(item, step.id))) return null;
    const thread = await cos.bb.sdk.threads.get({ threadId });
    node.deliveries = { ...node.deliveries, [agent]: { ...attempt, threadId } };
    cos.store.updateWorkItem(item.id, { nodes: item.nodes, ...(step.writes ? { threadId, environmentId: thread.environmentId ?? null } : {}) });
    cos.store.upsertThread({ threadId, itemId: item.id, role: step.writes ? "builder" : "step", stepId: step.id, agent, environmentId: thread.environmentId ?? item.environmentId, round: node.round, promptSentAt: attempt.sentAt });
    return cos.store.getWorkItem(item.id);
  });
}
