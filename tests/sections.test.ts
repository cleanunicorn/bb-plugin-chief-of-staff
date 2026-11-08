import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { issueSection } from "../src/sections";
import type { Cos } from "../src/context";
import type { WorkItem } from "../src/state";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

function setup() {
  const sections: { id: string; name: string; createdAt: number; updatedAt: number }[] = [];
  let next = 0;
  const host = createFakePluginHost({ sdk: { threadSections: {
    list: async () => sections,
    create: async ({ name }) => {
      const section = { id: `section_${++next}`, name, createdAt: 0, updatedAt: 0 };
      sections.push(section);
      return section;
    },
  } } });
  hosts.push(host);
  const cos = { bb: host.bb, safe: async (text: string) => text } as Cos;
  const item = { id: "item_1", repo: "acme/app", issueNumber: 12, issueTitle: "Fix login" } as WorkItem;
  return { host, cos, item, sections };
}

describe("native issue sections", () => {
  it("serializes simultaneous requests and preserves the saved identity after a reload and rename", async () => {
    const { host, cos, item, sections } = setup();
    expect(await Promise.all([issueSection(cos, item), issueSection(cos, item)])).toEqual(["section_1", "section_1"]);
    sections[0]!.name = "My renamed issue";
    expect(await issueSection({ ...cos }, { ...item, id: "rerun" })).toBe("section_1");
    expect(host.harness.inspection.sdk.callsTo("threadSections.create")).toHaveLength(1);
  });

  it("recreates a deleted section", async () => {
    const { cos, item, sections } = setup();
    expect(await issueSection(cos, item)).toBe("section_1");
    sections.length = 0;
    expect(await issueSection(cos, item)).toBe("section_2");
    expect(await issueSection(cos, item)).toBe("section_2");
  });

  it("keeps repositories, issues, and issue-less tasks separate", async () => {
    const { cos, item } = setup();
    const ids = await Promise.all([
      issueSection(cos, item),
      issueSection(cos, { ...item, repo: "acme/other" }),
      issueSection(cos, { ...item, issueNumber: 13 }),
      issueSection(cos, { ...item, issueNumber: null }),
      issueSection(cos, { ...item, issueNumber: null, id: "item_2" }),
    ]);
    expect(new Set(ids).size).toBe(5);
  });
});
