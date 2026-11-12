import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { buildPrBody } from "../src/delivery";
import { freshNode } from "../src/machine";
import { migrationsForDatabase, StateStore, type NewWorkItem } from "../src/state";
import { publicThreadUrl, threadUrl } from "../src/threads";
import { workflowSchema } from "../src/workflow";
import type { Cos } from "../src/context";

const workflow = workflowSchema.parse({ id: "t", name: "Test", steps: [
  { id: "build", name: "Build", type: "agent", writes: true, next: ["ship"] },
  { id: "ship", name: "Ship", type: "ship", action: "merge", onFail: "build" },
] });
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

function setup(appUrl?: string) {
  const host = createFakePluginHost({ pluginId: "test", ...(appUrl ? { appUrl } : {}) });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, migrationsForDatabase(db));
  const store = new StateStore(db);
  const cos = { bb: host.bb, store } as unknown as Cos;
  const item = (threadId: string | null) => store.insertWorkItem({ id: `item-${threadId}`, repo: "a/b", status: "agent", issueTitle: "Fix it", issueNumber: 7, branch: "cos/x", threadId, environmentId: null, prNumber: null, prUrl: null, providerId: "claude-code", model: "opus", lastError: null, source: "task", lastActivityAt: null, finishedAt: null, workflow, nodes: { build: { ...freshNode(), round: 1, status: "done" }, ship: freshNode() } } satisfies NewWorkItem);
  return { cos, item };
}

describe("publicThreadUrl", () => {
  it("links the web app when BB has a public URL, tolerating a trailing slash", () => {
    expect(publicThreadUrl(setup("https://bb.example.com").cos, "thr_1")).toBe("https://bb.example.com/threads/thr_1");
    expect(publicThreadUrl(setup("https://bb.example.com/").cos, "thr_1")).toBe("https://bb.example.com/threads/thr_1");
  });

  it("returns null without a web URL, while threadUrl keeps the operator-only fallback", () => {
    const { cos } = setup();
    expect(publicThreadUrl(cos, "thr_1")).toBeNull();
    expect(threadUrl(cos, "thr_1")).toBe("bb://threads/thr_1");
  });
});

describe("buildPrBody thread link", () => {
  it("links the builder thread when there is a web URL", async () => {
    const { cos, item } = setup("https://bb.example.com/");
    const body = await buildPrBody(cos, item("thr_1"), null);
    expect(body).toContain("- Agent: claude-code / opus ([thread](https://bb.example.com/threads/thr_1))");
  });

  it("leaves the link out without a web URL, with no bb:// and no empty link", async () => {
    const { cos, item } = setup();
    const body = await buildPrBody(cos, item("thr_1"), null);
    expect(body).toContain("- Agent: claude-code / opus\n");
    expect(body).not.toContain("bb://");
    expect(body).not.toContain("[thread]");
    expect(body).not.toContain("()");
  });

  it("has no thread link for an item without a builder thread", async () => {
    const { cos, item } = setup("https://bb.example.com");
    expect(await buildPrBody(cos, item(null), null)).not.toContain("[thread]");
  });
});
