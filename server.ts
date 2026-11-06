// Chief of Staff — BB plugin backend entry.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createContext } from "./src/context";
import { MIGRATIONS, StateStore } from "./src/state";
import { defineSettings } from "./src/settings";
import { registerRpc } from "./src/rpc";
import { registerCli } from "./src/cli";
import { registerTools } from "./src/tools";
import { reconcile } from "./src/roster";
import { observeActive, observeFailure, observeIdle, observeInteraction, snapshotOf, syncThread } from "./src/sync";
import { describeInteraction } from "./src/threads";
import { sweep } from "./src/sweep";
import { newJobGeneration } from "./src/delivery";

export type { rpcContract } from "./rpcContract";

export default async function plugin(bb: BbPluginApi) {
  newJobGeneration();
  const settings = defineSettings(bb);
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new StateStore(db);
  const cos = createContext(bb, store, settings);

  registerRpc(bb, cos);
  registerCli(bb, cos);
  registerTools(bb, cos);

  // ---- thread lifecycle → stage machine ----
  // Builder and reviewer threads both map to their work item.
  const touch = (threadId: string) => {
    const item = store.getWorkItemByThread(threadId);
    if (item) store.updateWorkItem(item.id, { lastActivityAt: cos.now().toISOString() });
    return item;
  };
  bb.events.on("experimental_thread.events", ({ thread }) => {
    touch(thread.id);
  });
  bb.events.on("thread.active", async ({ thread }) => {
    const item = touch(thread.id);
    if (item) await observeActive(cos, item.id, thread.id, "event");
  });
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const item = touch(thread.id);
    if (item) await observeIdle(cos, item.id, thread.id, snapshotOf(thread as never), lastAssistantText, "event");
  });
  bb.events.on("thread.failed", async ({ thread, error }) => {
    const item = touch(thread.id);
    if (item) await observeFailure(cos, item.id, thread.id, error ?? "thread errored", "event");
  });
  bb.events.on("interaction.pending", async ({ thread, interaction }) => {
    const item = touch(thread.id);
    if (item) await observeInteraction(cos, item.id, thread.id, describeInteraction(interaction), "event");
  });
  bb.events.on("thread.archived", async ({ thread }) => {
    const item = store.getWorkItemByThread(thread.id);
    // The reviewer's thread being archived after review is housekeeping, not a failure.
    if (item && !(item.reviewThreadId === thread.id && item.stage !== "review")) await observeFailure(cos, item.id, thread.id, "thread archived", "event");
  });
  bb.events.on("thread.unarchived", async ({ thread }) => {
    // Unarchiving brings the item back: let sync read the thread's state.
    const item = store.getWorkItemByThread(thread.id);
    if (item?.status === "failed" && item.lastError === "thread archived") {
      store.updateWorkItem(item.id, { status: "blocked", finishedAt: null });
      await syncThread(cos, store.getWorkItem(item.id) ?? item, snapshotOf(thread as never), "event");
      cos.invalidate();
    }
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    const item = store.getWorkItemByThread(thread.id);
    if (item && !(item.reviewThreadId === thread.id && item.stage !== "review")) await observeFailure(cos, item.id, thread.id, "thread deleted", "event");
  });

  settings.onChange(() => cos.invalidate());

  // ---- durable schedule: one sweep per minute ----
  bb.background.schedule("cos-sweep", "* * * * *", () => sweep(cos));

  // ---- startup reconcile ----
  bb.background.service("cos-reconcile", {
    async start(signal) {
      if (signal.aborted) return;
      try {
        await reconcile(cos);
      } catch (error) {
        bb.log.warn(`reconcile failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
      }
    },
  });

  bb.log.info("chief-of-staff loaded");
}
