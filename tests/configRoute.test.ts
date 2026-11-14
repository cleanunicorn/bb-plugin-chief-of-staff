// The Configure section ↔ page address mapping, in both directions.
import { describe, expect, it } from "vitest";
import { CONFIG_SECTIONS, configSectionFromSubPath, configSubPath } from "../components/cos/configRoute";

describe("configSubPath", () => {
  it("puts every section under config/", () => {
    expect(CONFIG_SECTIONS.map(configSubPath)).toEqual(["config/workflow", "config/repos", "config/general", "config/access", "config/advanced"]);
  });
});

describe("configSectionFromSubPath", () => {
  it("round-trips every section", () => {
    for (const section of CONFIG_SECTIONS) expect(configSectionFromSubPath(configSubPath(section))).toBe(section);
  });

  it("falls back to Workflows for a bare, empty or unknown section", () => {
    expect(configSectionFromSubPath("config")).toBe("workflow");
    expect(configSectionFromSubPath("config/")).toBe("workflow");
    expect(configSectionFromSubPath("")).toBe("workflow");
    expect(configSectionFromSubPath("config/nope")).toBe("workflow");
    expect(configSectionFromSubPath("config/Repos")).toBe("workflow");
  });

  it("ignores segments after the section", () => {
    expect(configSectionFromSubPath("config/repos/x")).toBe("repos");
    expect(configSectionFromSubPath("config/workflow/delivery/review")).toBe("workflow");
  });

  it("decodes a percent-encoded section", () => {
    expect(configSectionFromSubPath("config/%61ccess")).toBe("access");
  });

  it("falls back to Workflows instead of throwing on a malformed escape, so other tabs still load", () => {
    expect(configSectionFromSubPath("config/%E0")).toBe("workflow");
    expect(configSectionFromSubPath("agents/%E0")).toBe("workflow");
  });
});
