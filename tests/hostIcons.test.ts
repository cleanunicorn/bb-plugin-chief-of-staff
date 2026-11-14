// Every icon the UI asks for, resolved through the real host translation table against the host catalog.
// Component tests mock Icon and skip the table, which hid both collisions and missing artwork (#111).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk/app", () => ({ experimental_Icon: () => null }));
import { HOST_ICON_CATALOG, HOST_ICON_NAMES, hostIconName } from "../components/ui/icon";
import * as dashboardIcons from "../components/cos/dashboardIcons";

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
