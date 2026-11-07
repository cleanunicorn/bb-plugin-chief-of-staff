// Chart primitives for the Chief of Staff dashboard.
// Chrome (text, borders, surfaces) uses host theme tokens. Data marks use the validated
// dataviz palette: an ordinal blue ramp for pipeline stages and the fixed status palette.
// Status color always ships with an icon and a label.
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type Mode = "light" | "dark";

export const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" } as const;
export type Tone = keyof typeof STATUS | "neutral" | "info";

// Ordinal ramp (validated with --ordinal in both modes): early stage -> late stage.
const RAMP = {
  light: ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab"],
  dark: ["#184f95", "#256abf", "#3987e5", "#6da7ec"],
} as const;
const ACCENT = { light: "#2a78d6", dark: "#3987e5" } as const;
const TRACK = { light: "#cde2fb", dark: "#0d366b" } as const;

export interface Palette {
  mode: Mode;
  ramp: readonly string[];
  accent: string;
  track: string;
}

const PaletteContext = createContext<Palette>({ mode: "light", ramp: RAMP.light, accent: ACCENT.light, track: TRACK.light });
export const usePalette = () => useContext(PaletteContext);

export function toneColor(tone: Tone, palette: Palette): string {
  if (tone === "neutral") return "var(--muted-foreground)";
  if (tone === "info") return palette.accent;
  return STATUS[tone];
}

// Reads the effective background behind `ref` and decides light vs dark. The plugin CSS
// `dark:` variant follows the OS preference, not bb's theme, so we measure instead.
function lightnessOf(color: string): number | null {
  const nums = (color.match(/-?[\d.]+%?/g) ?? []).map((n) => (n.endsWith("%") ? parseFloat(n) / 100 : parseFloat(n)));
  if (color.startsWith("rgb")) {
    const [r, g, b, a] = nums;
    if (a === 0 || r === undefined || g === undefined || b === undefined) return null;
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return Math.cbrt(0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b));
  }
  if (color.startsWith("oklch") || color.startsWith("oklab")) return nums[0] ?? null;
  if (color.startsWith("lab") || color.startsWith("lch")) return nums[0] === undefined ? null : nums[0] > 1 ? nums[0] / 100 : nums[0];
  if (color.startsWith("color(")) {
    const [r, g, b] = nums;
    return r === undefined || g === undefined || b === undefined ? null : 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return null;
}

function detectMode(el: HTMLElement | null): Mode {
  let node: HTMLElement | null = el;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) {
      const l = lightnessOf(bg);
      if (l !== null) return l < 0.5 ? "dark" : "light";
    }
    node = node.parentElement;
  }
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useThemeMode(ref: RefObject<HTMLElement | null>): Mode {
  const [mode, setMode] = useState<Mode>("light");
  useEffect(() => {
    const update = () => setMode(detectMode(ref.current));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", update);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.("change", update);
    };
  }, [ref]);
  return mode;
}

export function PaletteProvider({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const mode = useThemeMode(ref);
  const palette: Palette = { mode, ramp: RAMP[mode], accent: ACCENT[mode], track: TRACK[mode] };
  return (
    <div ref={ref} className={className} data-cos-mode={mode}>
      <PaletteContext.Provider value={palette}>{children}</PaletteContext.Provider>
    </div>
  );
}

// ---------- formatting ----------

export function relative(iso: string | null, now = Date.now()): string {
  if (!iso) return "–";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const future = ms < 0;
  const min = Math.round(Math.abs(ms) / 60_000);
  const text = min < 1 ? "now" : min < 60 ? `${min}m` : min < 48 * 60 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`;
  if (text === "now") return future ? "in <1m" : "just now";
  return future ? `in ${text}` : `${text} ago`;
}

export function duration(minutes: number | null): string {
  if (minutes === null) return "–";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ---------- chrome ----------

export function Panel({ title, icon, actions, children, className, dim }: { title: string; icon?: string; actions?: ReactNode; children: ReactNode; className?: string; dim?: boolean }) {
  return (
    <section className={cn("flex min-w-0 flex-col rounded-xl border border-border bg-card", className)}>
      <header className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {icon ? <Icon name={icon} fallback="Circle" className="size-4 text-muted-foreground" aria-hidden /> : null}
          {title}
        </h2>
        <div className="flex items-center gap-1">{actions}</div>
      </header>
      <div className={cn("min-w-0 px-4 pb-4 transition-opacity", dim && "opacity-60")}>{children}</div>
    </section>
  );
}

export function Swatch({ color, shape = "square" }: { color: string; shape?: "square" | "dot" }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0", shape === "dot" ? "rounded-full" : "rounded-[3px]")} style={{ background: color }} />;
}

const TONE_ICON: Record<Tone, string> = { good: "CircleCheck", warning: "TriangleAlert", serious: "CircleAlert", critical: "CircleX", neutral: "Circle", info: "Info" };

// A status pill: colored icon + text in ink. Never color alone.
export function StatusPill({ tone, label, icon, pulse }: { tone: Tone; label: string; icon?: string; pulse?: boolean }) {
  const palette = usePalette();
  const color = toneColor(tone, palette);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground">
      <span className="relative inline-flex">
        {pulse ? <span aria-hidden className="absolute inset-0 animate-ping rounded-full opacity-40" style={{ background: color }} /> : null}
        <Icon name={icon ?? TONE_ICON[tone]} fallback="Circle" className="relative size-3.5" style={{ color }} aria-hidden />
      </span>
      {label}
    </span>
  );
}

// ---------- stat tiles ----------

export function StatTile({ label, value, sub, icon, tone, hero, children, onClick }: { label: string; value: ReactNode; sub?: ReactNode; icon: string; tone?: Tone; hero?: boolean; children?: ReactNode; onClick?: () => void }) {
  const palette = usePalette();
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-4 text-left",
        onClick && "cursor-pointer transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon name={icon} fallback="Circle" className="size-3.5" style={tone && tone !== "neutral" ? { color: toneColor(tone, palette) } : undefined} aria-hidden />
        {label}
      </span>
      <span className={cn("font-semibold leading-none tracking-tight text-foreground", hero ? "text-5xl" : "text-3xl")} style={{ fontVariantNumeric: "proportional-nums" }}>
        {value}
      </span>
      {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
      {children}
    </Tag>
  );
}

// ---------- meter ----------

export function Meter({ value, max, label, size = "md" }: { value: number; max: number; label: string; size?: "sm" | "md" }) {
  const palette = usePalette();
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const full = max > 0 && value >= max;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn("w-full overflow-hidden rounded-full", size === "sm" ? "h-1.5" : "h-2")}
      style={{ background: palette.track }}
      title={`${label}: ${value} of ${max}`}
    >
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${ratio * 100}%`, background: full ? STATUS.serious : palette.accent }} />
    </div>
  );
}

// ---------- hover tooltip ----------

function useTooltip() {
  const [tip, setTip] = useState<{ x: number; content: ReactNode } | null>(null);
  return { tip, show: (x: number, content: ReactNode) => setTip({ x, content }), hide: () => setTip(null) };
}

function Tooltip({ tip }: { tip: { x: number; content: ReactNode } | null }) {
  if (!tip) return null;
  return (
    <div role="tooltip" className="pointer-events-none absolute bottom-full z-10 mb-2 -translate-x-1/2 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap text-popover-foreground shadow-md" style={{ left: `${tip.x}%`, background: "var(--popover, var(--card))" }}>
      {tip.content}
    </div>
  );
}

// ---------- tall segmented bar (part-to-whole, <= 6 parts) ----------

export interface Part {
  key: string;
  label: string;
  value: number;
  color: string;
  icon?: string;
}

export function SegmentedBar({ parts, total, label, unit = "items" }: { parts: Part[]; total?: number; label: string; unit?: string }) {
  const sum = total ?? parts.reduce((a, p) => a + p.value, 0);
  const { tip, show, hide } = useTooltip();
  const visible = parts.filter((p) => p.value > 0);
  let offset = 0;
  return (
    <div className="relative">
      <Tooltip tip={tip} />
      <div role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(", ")}`} className="flex h-7 w-full gap-0.5 overflow-hidden rounded-[4px]">
        {sum === 0 ? <div className="h-full w-full rounded-[4px] bg-muted" /> : null}
        {visible.map((p) => {
          const pct = (p.value / sum) * 100;
          const mid = offset + pct / 2;
          offset += pct;
          const content = (
            <span className="flex items-center gap-1.5">
              <Swatch color={p.color} />
              <span className="font-medium">{p.label}</span>
              <span className="text-muted-foreground">
                {p.value} {unit} · {Math.round(pct)}%
              </span>
            </span>
          );
          return (
            <button
              key={p.key}
              type="button"
              aria-label={`${p.label}: ${p.value}`}
              className="h-full min-w-1 transition-[flex-grow] duration-500 first:rounded-l-[4px] last:rounded-r-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              style={{ flexGrow: p.value, flexBasis: 0, background: p.color }}
              onMouseEnter={() => show(mid, content)}
              onFocus={() => show(mid, content)}
              onMouseLeave={hide}
              onBlur={hide}
            />
          );
        })}
      </div>
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; icon?: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          {i.icon ? <Icon name={i.icon} fallback="Circle" className="size-3.5" style={{ color: i.color }} aria-hidden /> : <Swatch color={i.color} />}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

// ---------- stacked column chart (time series, one axis) ----------

export interface Series {
  key: string;
  label: string;
  color: string;
  icon?: string;
}

export function ColumnChart<Row extends Record<string, number | string>>({ rows, series, xKey, formatX, height = 120, label }: { rows: Row[]; series: Series[]; xKey: keyof Row; formatX: (v: string) => string; height?: number; label: string }) {
  const { tip, show, hide } = useTooltip();
  const totals = rows.map((r) => series.reduce((a, s) => a + Number(r[s.key] ?? 0), 0));
  const rawMax = Math.max(1, ...totals);
  const step = rawMax <= 4 ? 1 : rawMax <= 10 ? 2 : rawMax <= 25 ? 5 : 10;
  const max = Math.ceil(rawMax / step) * step;
  const ticks = [max, max / 2, 0].filter((t, i, a) => Number.isInteger(t) && a.indexOf(t) === i);
  const labelIdx = new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1]);
  const id = useId();
  return (
    <figure className="flex flex-col gap-2" aria-labelledby={id}>
      <figcaption id={id} className="sr-only">
        {label}
      </figcaption>
      <div className="flex gap-2">
        <div className="relative flex flex-col justify-between text-right text-[11px] text-muted-foreground tabular-nums" style={{ height }}>
          {ticks.map((t) => (
            <span key={t} className="-translate-y-1/2 leading-none first:translate-y-0 last:translate-y-0">
              {t}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          <Tooltip tip={tip} />
          {ticks.map((t) => (
            <div key={t} aria-hidden className="absolute inset-x-0 border-t border-border" style={{ top: `${(1 - t / max) * height}px` }} />
          ))}
          <div className="relative flex items-end justify-between gap-0.5" style={{ height }}>
            {rows.map((r, i) => {
              const x = String(r[xKey]);
              const content = (
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{formatX(x)}</span>
                  {series.map((s) => (
                    <span key={s.key} className="flex items-center gap-1.5">
                      <Swatch color={s.color} />
                      {s.label}
                      <span className="ml-auto pl-3 font-medium tabular-nums">{Number(r[s.key] ?? 0)}</span>
                    </span>
                  ))}
                </span>
              );
              const xPct = ((i + 0.5) / rows.length) * 100;
              return (
                <button
                  key={x}
                  type="button"
                  aria-label={`${formatX(x)}: ${series.map((s) => `${s.label} ${Number(r[s.key] ?? 0)}`).join(", ")}`}
                  className="group flex h-full flex-1 cursor-default items-end justify-center rounded-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
                  onMouseEnter={() => show(xPct, content)}
                  onFocus={() => show(xPct, content)}
                  onMouseLeave={hide}
                  onBlur={hide}
                >
                  <span className="flex w-full max-w-6 flex-col-reverse gap-0.5">
                    {series.map((s, si) => {
                      const v = Number(r[s.key] ?? 0);
                      if (!v) return null;
                      const isTop = series.slice(si + 1).every((n) => !Number(r[n.key] ?? 0));
                      return <span key={s.key} className={cn("block w-full", isTop && "rounded-t-[4px]")} style={{ height: (v / max) * height - 2, minHeight: 2, background: s.color }} />;
                    })}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
            {rows.map((r, i) => (
              <span key={String(r[xKey])} className="flex-1 text-center">
                {labelIdx.has(i) ? formatX(String(r[xKey])) : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color, icon: s.icon }))} />
    </figure>
  );
}

// ---------- data table (table view for every chart) ----------

export function DataTable({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            {columns.map((c, i) => (
              <th key={c} className={cn("py-1.5 pr-3 font-medium", i > 0 && "text-right")}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-border last:border-0">
              {r.map((cell, ci) => (
                <td key={ci} className={cn("py-1.5 pr-3 text-foreground", ci > 0 && "text-right tabular-nums")}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ViewToggle({ table, onChange }: { table: boolean; onChange: (table: boolean) => void }) {
  return (
    <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="View">
      {([false, true] as const).map((t) => (
        <button
          key={String(t)}
          type="button"
          aria-pressed={table === t}
          title={t ? "Table view" : "Chart view"}
          onClick={() => onChange(t)}
          className={cn("rounded-[5px] p-1 text-muted-foreground hover:text-foreground", table === t && "bg-state-active text-foreground")}
        >
          <Icon name={t ? "Table" : "ChartColumn"} fallback={t ? "List" : "BarChart3"} className="size-3.5" aria-label={t ? "Table view" : "Chart view"} />
        </button>
      ))}
    </div>
  );
}
