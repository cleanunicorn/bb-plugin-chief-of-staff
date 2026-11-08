// A rejected SDK call does not establish non-delivery. Persist an identity
// before calling BB and reconcile that exact identity before doing more work.
import { randomUUID } from "node:crypto";
import type { Cos } from "./context";
import type { AgentDelivery } from "./machine";
import type { WorkItem } from "./state";
import type { AgentStep } from "./workflow";

export class UnknownDelivery extends Error {}

export function saveDelivery(cos: Cos, itemId: string, step: string, agent: number, delivery: AgentDelivery): void {
  const item = cos.store.getWorkItem(itemId);
  const node = item?.nodes[step];
  if (!item || !node || node.round !== delivery.round) return;
  cos.store.updateWorkItem(itemId, { nodes: { ...item.nodes, [step]: { ...node, deliveries: { ...node.deliveries, [agent]: delivery } } } });
}

export function newDelivery(round: number, startedAt: number): AgentDelivery {
  return { id: randomUUID(), round, startedAt, threadId: null, status: "preparing" };
}

export function deliveryMarker(id: string): string { return `[Chief of Staff delivery: ${id}]`; }

export function bindDelivery(cos: Cos, item: WorkItem, step: AgentStep, agent: number, delivery: AgentDelivery, environmentId: string | null): void {
  if (!delivery.threadId) return;
  if (step.writes) cos.store.updateWorkItem(item.id, { threadId: delivery.threadId, environmentId });
  cos.store.upsertThread({ threadId: delivery.threadId, itemId: item.id, role: step.writes ? "builder" : "step", stepId: step.writes ? null : step.id, agent, environmentId, round: delivery.round, promptSentAt: delivery.startedAt });
}

/** Returns positive evidence only. Missing/unavailable observations are unknown. */
export async function reconcileDelivery(cos: Cos, item: WorkItem, step: AgentStep, agent: number): Promise<AgentDelivery | null> {
  const delivery = item.nodes[step.id]?.deliveries?.[agent];
  if (!delivery || delivery.status === "preparing" || delivery.round !== item.nodes[step.id].round) return null;
  if (delivery.status === "sent") {
    const row = delivery.threadId ? cos.store.getThread(delivery.threadId) : null;
    if (!row || row.round !== delivery.round) {
      if (!delivery.threadId) return null;
      try {
        const thread = await cos.bb.sdk.threads.get({ threadId: delivery.threadId });
        bindDelivery(cos, item, step, agent, delivery, thread.environmentId ?? item.environmentId);
      } catch { return null; }
    }
    return delivery;
  }
  const found = { ...delivery };
  try {
    if (!found.threadId) {
      const repo = await cos.repo(item.repo);
      if (!repo) return null;
      // Metadata carries the attempt identity even when spawn loses its response.
      const threads = await cos.bb.sdk.threads.list({ projectId: repo.projectId, originPluginId: "chief-of-staff", includeHidden: true, limit: 200 });
      for (const thread of threads) {
        const meta = await cos.bb.sdk.threads.getPluginMetadata({ threadId: thread.id, pluginId: "chief-of-staff" });
        if (meta.deliveryAttempt !== found.id || meta.workItemId !== item.id) continue;
        found.threadId = thread.id;
        saveDelivery(cos, item.id, step.id, agent, found);
        bindDelivery(cos, item, step, agent, found, thread.environmentId ?? null);
        break;
      }
    }
    if (!found.threadId) return null;
    const marker = deliveryMarker(found.id);
    const queue = await cos.bb.sdk.threads.queuedMessages.list({ threadId: found.threadId });
    if (queue.some((row) => row.content.some((part) => part.type === "text" && part.text.includes(marker)))) {
      found.status = "queued";
    } else {
      const history = await cos.bb.sdk.threads.promptHistory({ threadId: found.threadId, limit: "100" });
      if (!history.some((row) => row.input.some((part) => part.type === "text" && part.text.includes(marker)))) return null;
      found.status = "sent";
    }
    saveDelivery(cos, item.id, step.id, agent, found);
    return found;
  } catch {
    // Neither an empty window nor an API outage proves that a prompt was lost.
    return null;
  }
}

/** Only a prompt-send failure for this agent can be cleared by its report. */
export function deliveryWait(item: WorkItem, step: string, agent: number): boolean {
  const node = item.nodes[step];
  return node?.waiting?.kind === "cos_error" && node.retry?.effect.type === "agent" && node.retry.effect.agent === agent && !node.retry.effect.fresh;
}
