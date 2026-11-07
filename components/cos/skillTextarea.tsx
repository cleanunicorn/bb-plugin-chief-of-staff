// Instructions textarea with agent skills: typing `/` suggests the skills the
// configured projects have, and the skills the text references are listed
// under it (a warning when bb does not know one). Chief of Staff turns the
// references into skill mentions when it prompts the agent.
import { useId, useMemo, useRef, useState } from "react";
import { matchSkills, referencedSkills, skillQueryAt, type KnownSkill } from "../../src/skills";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { STATUS } from "./viz";

export function SkillTextarea({ id, value, onChange, placeholder, className, skills }: { id?: string; value: string; onChange: (v: string) => void; placeholder?: string; className?: string; skills: readonly KnownSkill[] | null }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const query = caret === null ? null : skillQueryAt(value, caret);
  const matches = useMemo(() => (query && skills ? matchSkills(skills, query.query) : []), [query?.query, query?.start, skills]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = Boolean(query && matches.length && dismissed !== query.start);
  const used = useMemo(() => referencedSkills(value), [value]);
  const known = useMemo(() => new Set((skills ?? []).map((s) => s.name)), [skills]);

  const track = () => {
    const el = ref.current;
    if (el) setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  };
  const pick = (skill: KnownSkill) => {
    if (!query || caret === null) return;
    const after = value.slice(caret);
    const insert = `/${skill.name}${/^\s/.test(after) ? "" : " "}`;
    const next = value.slice(0, query.start) + insert + after;
    const at = query.start + insert.length;
    onChange(next);
    setCaret(at);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(at, at);
    });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <textarea
          ref={ref}
          id={id}
          className={className}
          value={value}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart === e.target.selectionEnd ? e.target.selectionStart : null);
            setActive(0);
            setDismissed(null);
          }}
          onSelect={track}
          onClick={track}
          onBlur={() => setCaret(null)}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
            } else if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(matches[Math.min(active, matches.length - 1)]!);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(query!.start);
            }
          }}
        />
        {open ? (
          <ul id={listId} role="listbox" aria-label="Skills" className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md">
            {matches.map((s, i) => (
              <li
                key={s.name}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn("flex cursor-pointer flex-col rounded px-2 py-1", i === active ? "bg-state-active" : "hover:bg-state-hover")}
              >
                <span className="font-mono text-xs text-foreground">/{s.name}</span>
                {s.description ? <span className="line-clamp-1 text-[11px] text-muted-foreground">{s.description}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {used.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>Skills:</span>
          {used.map((name) => {
            const missing = skills !== null && !known.has(name);
            return (
              <span
                key={name}
                title={missing ? "No configured project has this skill; the agent gets the text as written." : "The agent loads this skill."}
                className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono", missing ? "border-dashed" : "border-border text-foreground")}
                style={missing ? { color: STATUS.warning, borderColor: STATUS.warning } : undefined}
              >
                <Icon name={missing ? "TriangleAlert" : "Sparkles"} fallback="Circle" className="size-3" aria-hidden />/{name}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
