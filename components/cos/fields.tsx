// Form primitives shared by the configurator and the workflow editor.
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { parseList } from "../../src/configModel";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { STATUS } from "./viz";


export const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

export function Field({ label, hint, children, className, error }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode; className?: string; error?: string | null }) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children(id)}
      {error ? <span className="text-[11px]" style={{ color: STATUS.critical }}>{error}</span> : hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export function TextInput({ id, value, onChange, placeholder, mono, type = "text" }: { id?: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; type?: string }) {
  return <input id={id} type={type} className={cn(inputClass, mono && "font-mono text-xs")} value={value} placeholder={placeholder} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.target.value)} />;
}

/**
 * Number field that tolerates an empty box while typing and keeps what is
 * typed within `min`..`max`. A value it is given out of range (set elsewhere)
 * is shown as is and never reported back. Clamping to `min` while typing
 * works because every `min` is 0 or 1; a field with a `min` of 2 or more
 * would need it on blur instead, or the first digit could not be typed.
 */
export function NumberInput({ id, value, onChange, min, max }: { id?: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      className={cn(inputClass, "tabular-nums")}
      value={text}
      min={min}
      max={max}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() === "" || !Number.isFinite(n)) return;
        let v = Math.round(n);
        if (max !== undefined) v = Math.min(max, v);
        if (min !== undefined) v = Math.max(min, v);
        // Out of range: show the limit now, even when the value does not change.
        if (v !== Math.round(n)) setText(String(v));
        onChange(v);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

/** Comma-separated list editor that keeps the raw text while focused. */
export function ListInput({ id, value, onChange, placeholder }: { id?: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const joined = value.join(", ");
  const [text, setText] = useState(joined);
  useEffect(() => {
    if (parseList(text).join(", ") !== joined) setText(joined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return (
    <input
      id={id}
      className={inputClass}
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseList(e.target.value));
      }}
      onBlur={() => setText(joined)}
    />
  );
}

export function Select<T extends string>({ id, value, onChange, options, disabled }: { id?: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; disabled?: boolean }) {
  return (
    <select id={id} className={cn(inputClass, "pr-7")} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50", checked ? "bg-foreground" : "bg-muted")}
    >
      <span className={cn("absolute left-0 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform", checked ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}

export function ToggleRow({ label, hint, checked, onChange, accent }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; accent?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          {label}
          {accent}
        </div>
        {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export function Group({ title, icon, children, cols = 2 }: { title: string; icon: string; children: ReactNode; cols?: 1 | 2 | 3 }) {
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        <Icon name={icon} fallback="Circle" className="size-3.5" aria-hidden />
        {title}
      </legend>
      <div className={cn("grid gap-3", cols === 1 ? "grid-cols-1" : cols === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-3")}>{children}</div>
    </fieldset>
  );
}

export function Problems({ items, tone = "critical" }: { items: string[]; tone?: "critical" | "warning" }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-col gap-1 rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground">
      {items.map((p) => (
        <li key={p} className="flex items-start gap-1.5">
          <Icon name={tone === "critical" ? "CircleX" : "TriangleAlert"} fallback="Circle" className="mt-px size-3.5 shrink-0" style={{ color: STATUS[tone] }} aria-hidden />
          {p}
        </li>
      ))}
    </ul>
  );
}

export function ConfirmRemove({ onConfirm, label }: { onConfirm: () => void; label: string }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground" onClick={() => setAsking(true)} aria-label={label}>
        <Icon name="Trash2" fallback="Circle" aria-hidden />
      </Button>
    );
  return (
    <span className="flex items-center gap-1 text-xs text-foreground">
      Remove?
      <Button size="sm" variant="destructive" className="h-7 px-2" onClick={onConfirm}>
        Remove
      </Button>
      <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setAsking(false)}>
        Keep
      </Button>
    </span>
  );
}

