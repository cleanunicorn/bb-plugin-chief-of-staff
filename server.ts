// Chief of Staff — BB plugin backend entry.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createContext } from "./src/context";
import { MIGRATIONS, StateStore } from "./src/state";
import { defineSettings } from "./src/settings";
import { registerRpc } from "./src/rpc";
import { registerCli } from "./src/cli";
import { registerTools } from "./src/tools";
import { dispatch } from "./src/delivery";
import { reconcile } from "./src/roster";
import { handleActive, handleIdle, syncItem } from "./src/sync";
import { describeInteraction } from "./src/threads";
import { sweep } from "./src/sweep";

export type { rpcContract } from "./rpcContract";

export default async function plugin(bb: BbPluginApi) {
  const settings = defineSettings(bb);
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new StateStore(db);
  const cos = createContext(bb, store, settings);

  registerRpc(bb, cos);
  registerCli(bb, cos);
  registerTools(bb, cos);

  // ---- thread lifecycle → state machine ----
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
    if (item) await handleActive(cos, item, "event");
  });
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const item = touch(thread.id);
    if (item) await handleIdle(cos, item, lastAssistantText, "event");
  });
  bb.events.on("thread.failed", async ({ thread, error }) => {
    const item = touch(thread.id);
    if (item) await dispatch(cos, item.id, { type: "thread_failed", error: error ?? "thread errored" }, "event");
  });
  bb.events.on("interaction.pending", async ({ thread, interaction }) => {
    const item = touch(thread.id);
    if (item) await dispatch(cos, item.id, { type: "thread_waiting_on_human", reason: describeInteraction(interaction) }, "event");
  });
  bb.events.on("thread.archived", async ({ thread }) => {
    const item = store.getWorkItemByThread(thread.id);
    if (item && !["done", "failed"].includes(item.status)) await dispatch(cos, item.id, { type: "thread_failed", error: "thread archived" }, "event");
  });
  bb.events.on("thread.unarchived", async ({ thread }) => {
    // Unarchiving brings the item back: resume it and let sync pick up the thread's state.
    const item = store.getWorkItemByThread(thread.id);
    if (item?.status === "failed" && item.lastError === "thread archived") {
      await dispatch(cos, item.id, { type: "human_resume" }, "event");
      const resumed = store.getWorkItem(item.id);
      if (resumed) await syncItem(cos, resumed, "event");
    }
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    const item = store.getWorkItemByThread(thread.id);
    if (item && !["done", "failed"].includes(item.status)) await dispatch(cos, item.id, { type: "thread_failed", error: "thread deleted" }, "event");
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
