// Every icon the UI asks for, resolved through the real host translation table against the host catalog.
// Component tests mock Icon and skip the table, which hid both collisions and missing artwork (#111).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk/app", () => ({ experimental_Icon: () => null }));
import { HOST_ICON_BASE, HOST_ICON_CATALOG, HOST_ICON_FALLBACKS, HOST_ICON_NAMES, hostIconFallback, hostIconName } from "../components/ui/icon";
import * as dashboardIcons from "../components/cos/dashboardIcons";
import { STAGES } from "../components/cos/stages";
import { TONE_ICON } from "../components/cos/viz";
import { OUTCOME_META } from "../src/outcome";

const ROOT = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { bb: { branding: { experimental_icons: Record<string, string> } } };
const PLUGIN_ICONS = new Set(
  Object.entries(pkg.bb.branding.experimental_icons)
    .filter(([, file]) => existsSync(join(ROOT, file)))
    .map(([key]) => `chief-of-staff/${key}`),
);
const drawable = (host: string) => HOST_ICON_CATALOG.has(host) || PLUGIN_ICONS.has(host);

// ---------- source scan ----------

const ICON_NAME = /^(?:[A-Z][A-Za-z0-9]*|chief-of-staff\/[a-z0-9-]+)$/;

/** The end (exclusive) of the expression starting at `i`: a quoted string, a `{…}` block, or (for `icon:`) up to `,` `}` `;` or a newline at depth 0. */
function expressionEnd(src: string, i: number, objectValue: boolean): number {
  let depth = 0;
  let quote: string | null = null;
  if (!objectValue && src[i] === '"') return src.indexOf('"', i + 1) + 1;
  for (let k = i; k < src.length; k++) {
    const c = src[k]!;
    if (quote) {
      if (c === "\\") k++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return k;
      depth--;
      if (depth === 0 && !objectValue) return k + 1;
    } else if (objectValue && depth === 0 && (c === "," || c === ";" || c === "\n")) return k;
  }
  return src.length;
}

/** Icon names requested in a source file: string literals inside `name=`, `icon=`, `fallback=` and `icon:` values, ternaries included. */
export function requestedIcons(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(?:(name|icon|fallback)=|(icon)\??:\s*)/g)) {
    const start = m.index + m[0].length;
    const objectValue = Boolean(m[2]);
    if (!objectValue && src[start] !== '"' && src[start] !== "{") continue;
    const expr = src.slice(start, expressionEnd(src, start, objectValue));
    for (const lit of expr.matchAll(/"([^"\n]*)"/g)) if (ICON_NAME.test(lit[1]!)) out.push(lit[1]!);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(f) ? [p] : [];
  });
}

/** Every icon name inside the dashboard icon tables, whatever their keys are called; in `{ label, icon }` rows, only the icon. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return "icon" in value ? strings(value.icon) : Object.values(value).flatMap(strings);
  return [];
}

const SOURCES = [join(ROOT, "app.tsx"), ...sourceFiles(join(ROOT, "components")), ...sourceFiles(join(ROOT, "src"))];
const REQUESTED = new Map<string, string>(); // icon name → first file that asks for it
for (const file of SOURCES) for (const name of requestedIcons(readFileSync(file, "utf8"))) if (!REQUESTED.has(name)) REQUESTED.set(name, file.slice(ROOT.length + 1));
for (const name of strings(dashboardIcons)) if (ICON_NAME.test(name) && !REQUESTED.has(name)) REQUESTED.set(name, "components/cos/dashboardIcons.ts");

describe("host icon catalog", () => {
  it("maps every name to artwork the host or the plugin ships", () => {
    const missing = Object.entries(HOST_ICON_NAMES).filter(([, host]) => !drawable(host));
    expect(missing).toEqual([]);
  });

  it("declares plugin icons whose SVG exists", () => {
    for (const [key, file] of Object.entries(pkg.bb.branding.experimental_icons)) expect(existsSync(join(ROOT, file)), key).toBe(true);
  });

  it("finds icon names in attributes, object values and ternaries, and nothing else", () => {
    const src = `
      <Icon name={finished ? "CalendarCheck" : "Timer"} fallback="Clock" />
      <Icon name={includeDone ? "EyeOff" : "History"} />
      <Icon name={on ? (q.multiSelect ? "SquareCheck" : "CircleDot") : "Circle"} />
      const LEVEL = { info: { tone: "info", icon: "Info", label: "Info" } };
      <StatusPill icon={dryRun ? "Eye" : undefined} label={dryRun ? "Dry run" : "Done"} />
      {r.paused ? "Resume" : "Pause"}
      icon: "h-9 w-9",
    `;
    expect(requestedIcons(src).sort()).toEqual(["CalendarCheck", "Circle", "CircleDot", "Clock", "Eye", "EyeOff", "History", "Info", "SquareCheck", "Timer"]);
  });

  it("scans the real source: it sees the names the issue calls out", () => {
    for (const name of ["CalendarCheck", "EyeOff", "SquareCheck", "Timer", "MessageCircleQuestion"]) expect(REQUESTED.has(name), name).toBe(true);
  });

  it("resolves every icon the source requests to artwork, never the host's Zap or Circle stand-in", () => {
    const missing = [...REQUESTED].filter(([name]) => !drawable(hostIconName(name))).map(([name, file]) => `${name} (${file})`);
    expect(missing).toEqual([]);
  });
});

it("maps names the host lacks and passes the rest through", () => {
  expect(hostIconName("ListChecks")).toBe("LayoutList");
  expect(hostIconName("GitMerge")).toBe("GitMerge");
});

// ---------- meaning groups: things shown side by side must not share a picture ----------

type Meanings = Record<string, string>; // meaning → requested icon name

/** Pairs of meanings that resolve to the same host icon, unless an allowed class holds both. */
function collisions(meanings: Meanings, allowed: string[][] = []): string[] {
  const entries = Object.entries(meanings).map(([meaning, name]) => [meaning, hostIconName(name)] as const);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      const [a, ha] = entries[i]!;
      const [b, hb] = entries[j]!;
      if (ha === hb && !allowed.some((c) => c.includes(a) && c.includes(b))) out.push(`${a} = ${b} (${ha})`);
    }
  return out;
}

const prefixed = (prefix: string, table: Record<string, string | { icon: string }>): Meanings =>
  Object.fromEntries(Object.entries(table).map(([k, v]) => [`${prefix}.${k}`, typeof v === "string" ? v : v.icon]));

const { ATTENTION_ICON, DETAIL_ICON, STALLED_ICON, WAITING_LABEL } = dashboardIcons;

/** Every icon a card's state mark can show (app.tsx entryTone, plus the stalled override). */
const STATE_MARKS: Meanings = {
  ...prefixed("outcome", OUTCOME_META),
  ...prefixed("detail", DETAIL_ICON),
  ...prefixed("waiting", WAITING_LABEL),
  ...prefixed("stage", Object.fromEntries(STAGES.map((s) => [s.key, s.icon]))),
  stalled: STALLED_ICON,
};

/** Meanings that may share a state mark, each with the reason. */
const SAME_STATE: string[][] = [
  ["detail.done", "outcome.completed"], // a finished task with no outcome reads as completed
  ["detail.failed", "outcome.failed"],
  ["detail.blocked", "waiting.stalled", "stalled"], // all three are "stalled"
  ["detail.ci", "stage.pr", "outcome.pr_opened"], // all mean "a PR is open"
  ["detail.agent", "stage.agent"],
  ["stage.human", "waiting.escalation"], // "Needs you" is the hand-off; "Your call" is the plain hand-off
  // Pre-existing and not a host substitution: Ready to merge shows GitMerge like Merged. Follow-up, out of scope here.
  ["detail.ready", "outcome.merged"],
];

describe("state marks", () => {
  it("gives every state its own host icon, outside the allowed same-meaning classes", () => {
    expect(collisions(STATE_MARKS, SAME_STATE)).toEqual([]);
  });

  it("never draws a stalled task like a queued one", () => {
    expect(hostIconName(STALLED_ICON)).not.toBe(hostIconName(STAGES.find((s) => s.key === "queued")!.icon));
  });

  it("keeps the Needs-attention chips apart", () => {
    expect(collisions(prefixed("attention", { failures: ATTENTION_ICON.failures, stalled: ATTENTION_ICON.stalled, input: ATTENTION_ICON.input }))).toEqual([]);
  });

  it("keeps the status pill tones apart, and away from the stalled and CoS-stuck marks", () => {
    expect(collisions(prefixed("tone", TONE_ICON))).toEqual([]);
    const tones = new Set(Object.values(TONE_ICON).map(hostIconName));
    expect(tones.has(hostIconName(STALLED_ICON))).toBe(false);
    expect(tones.has(hostIconName(WAITING_LABEL.cos_error!.icon))).toBe(false);
  });
});

const { CARD_ICON, FILTER_ICON, PANEL_ICON, SHOW_ACTIVITY_ICON, TASK_SUMMARY_ICON } = dashboardIcons;

describe("task card", () => {
  const { finishedAge, age, ...rows } = CARD_ICON;
  it.each([
    ["active", age],
    ["finished", finishedAge],
  ])("gives each row of the %s card its own icon", (_kind, ageIcon) => {
    expect(collisions(prefixed("card", { ...rows, age: ageIcon }))).toEqual([]);
  });

  it("never repeats a state mark in the card's rows, so a queued card shows Clock once at most", () => {
    const rowHosts = new Set(Object.values(CARD_ICON).map(hostIconName));
    const clashes = Object.entries(STATE_MARKS).filter(([, name]) => rowHosts.has(hostIconName(name)));
    expect(clashes).toEqual([]);
  });
});

describe("panel titles", () => {
  it("gives each dashboard panel its own icon", () => {
    expect(collisions(prefixed("panel", PANEL_ICON))).toEqual([]);
  });

  it("keeps Last activity, the Activity panel, Throughput and Capacity apart", () => {
    expect(collisions({ lastActivity: CARD_ICON.lastActivity, activity: PANEL_ICON.activity, throughput: PANEL_ICON.throughput, capacity: PANEL_ICON.capacity })).toEqual([]);
  });

  it("draws Show activity like the Activity panel it opens", () => {
    expect(hostIconName(SHOW_ACTIVITY_ICON)).toBe(hostIconName(PANEL_ICON.activity));
  });

  it("keeps Tokens and Cost apart from Task slots", () => {
    expect(collisions({ tokens: CARD_ICON.tokens, slots: FILTER_ICON.taskSlots })).toEqual([]);
    expect(collisions({ cost: CARD_ICON.cost, slots: FILTER_ICON.taskSlots })).toEqual([]);
  });
});

it("gives each item of a task's summary its own icon", () => {
  expect(collisions(prefixed("summary", TASK_SUMMARY_ICON))).toEqual([]);
});

const { VIEW_ICON } = dashboardIcons;

describe("filter row and toggles", () => {
  it("gives All tasks, each stage chip and Task slots their own icons", () => {
    const row = { all: FILTER_ICON.all, ...Object.fromEntries(STAGES.map((s) => [s.key, s.icon])), taskSlots: FILTER_ICON.taskSlots };
    expect(collisions(prefixed("filter", row))).toEqual([]);
  });

  it("keeps the Throughput chart and table switches apart, and apart from the panel title", () => {
    expect(collisions({ title: PANEL_ICON.throughput, chart: VIEW_ICON.chart, table: VIEW_ICON.table })).toEqual([]);
  });

  it("keeps the table switch apart from All tasks", () => {
    expect(hostIconName(VIEW_ICON.table)).not.toBe(hostIconName(FILTER_ICON.all));
  });
});

// ---------- older hosts ----------

// Extended-catalog names the UI already used before #111, on hosts back to engines.bb >=0.48. Any other name outside
// the base catalog needs a base stand-in in HOST_ICON_FALLBACKS, since only bb 0.49.0's catalog was checked.
const EXTENDED_BEFORE_111 = new Set(
  "ArrowReloadHorizontal ArrowRight ArrowTurnBackward ArrowUpRight Beaker BellDot CalendarCheckOut02 ChartColumn Clock EditFile Eye EyeOff FileText GitBranch GitMerge GitPullRequest GitPullRequestClosed GitPullRequestDraft Github GridView Layers ListView Lock Maximize2 Minimize2 Minus PackageReceive Pause Play Plus RotateCcw Sent Square Star TimeSchedule UserRound".split(" "),
);

describe("older hosts", () => {
  it("gives every extended-catalog name new to the plugin a base-catalog stand-in", () => {
    const hosts = new Set([...REQUESTED.keys()].map(hostIconName));
    const bare = [...hosts].filter((h) => HOST_ICON_CATALOG.has(h) && !HOST_ICON_BASE.has(h) && !EXTENDED_BEFORE_111.has(h) && !HOST_ICON_FALLBACKS[h]);
    expect(bare).toEqual([]);
  });

  it("only stands in with base-catalog names", () => {
    for (const [host, fallback] of Object.entries(HOST_ICON_FALLBACKS)) expect(HOST_ICON_BASE.has(fallback), `${host} → ${fallback}`).toBe(true);
  });

  it("prefers the stand-in over a caller's generic fallback, and keeps the caller's otherwise", () => {
    expect(hostIconFallback("Gauge", "Circle")).toBe(HOST_ICON_FALLBACKS.Limitation);
    expect(hostIconFallback("Timer", "Clock")).toBe("Clock");
    expect(hostIconFallback("Bot", undefined)).toBeUndefined();
  });
});
