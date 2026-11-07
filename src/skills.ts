// Agent skills in step instructions. A step's instructions may name skills as
// `/skill-name`, the way the bb composer does. When Chief of Staff sends the
// prompt, each reference to a skill installed in the workspace becomes a skill
// mention, so the provider loads the skill (Claude Code, Codex and ACP agents
// all honour them). Pure, so the configurator and the engine share it.

export interface SkillRef {
  name: string;
  /** Offset of the leading `/`. */
  start: number;
  /** Offset just past the name. */
  end: number;
}

export interface KnownSkill {
  name: string;
  description?: string | null;
  /** bb's skill scope: bb-builtin, bb-user, bb-project, provider-user, … */
  scope?: string | null;
}

export interface SkillMention {
  start: number;
  end: number;
  resource: { kind: "command"; label: string; name: string; argumentHint: null; origin: "builtin" | "project" | "user"; source: "skill"; trigger: "/" };
}

const NAME = /[A-Za-z0-9][A-Za-z0-9_.:-]*/y;
const TRAILING = /[.:]+$/;

/**
 * `/name` tokens in the text: the slash starts the text or follows whitespace
 * or an opening bracket/quote, and the name is not followed by another `/`
 * (so `/usr/bin` and `src/app` are not skills). Trailing `.` and `:` belong to
 * the sentence, not the name.
 */
export function findSkillRefs(text: string): SkillRef[] {
  const refs: SkillRef[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "/") continue;
    if (i > 0 && !/[\s([{"'`]/.test(text[i - 1]!)) continue;
    NAME.lastIndex = i + 1;
    const match = NAME.exec(text);
    if (!match) continue;
    const name = match[0].replace(TRAILING, "");
    const end = i + 1 + name.length;
    if (!name || text[i + 1 + match[0].length] === "/") continue;
    refs.push({ name, start: i, end });
    i = end - 1;
  }
  return refs;
}

/** Whether `/name` written in instructions reads back as this skill (bb also lists oddly named staging copies). */
export function isReferenceable(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(name) && !TRAILING.test(name);
}

/** The distinct skill names the text references. */
export function referencedSkills(text: string): string[] {
  return [...new Set(findSkillRefs(text).map((r) => r.name))];
}

function origin(scope: string | null | undefined): SkillMention["resource"]["origin"] {
  if (scope === "bb-builtin") return "builtin";
  if (scope && scope.endsWith("-project")) return "project";
  return "user";
}

/**
 * Skill mentions for the references to known skills inside `text`, limited to
 * the first occurrence of `section` (the step's instructions) so reports and
 * feedback quoted in the prompt never trigger a skill.
 */
export function skillMentions(text: string, section: string, skills: readonly KnownSkill[]): SkillMention[] {
  const body = section.trim();
  if (!body || !skills.length) return [];
  const offset = text.indexOf(body);
  if (offset < 0) return [];
  const byName = new Map(skills.map((s) => [s.name, s]));
  return findSkillRefs(body).flatMap((ref) => {
    const skill = byName.get(ref.name);
    if (!skill) return [];
    return [{ start: offset + ref.start, end: offset + ref.end, resource: { kind: "command" as const, label: skill.name, name: skill.name, argumentHint: null, origin: origin(skill.scope), source: "skill" as const, trigger: "/" as const } }];
  });
}

/** The skill reference the caret is typing, for the `/` typeahead: `/re|` → { query: "re", start }. */
export function skillQueryAt(text: string, caret: number): { query: string; start: number } | null {
  let i = caret;
  while (i > 0 && /[A-Za-z0-9_.:-]/.test(text[i - 1]!)) i--;
  if (i === 0 || text[i - 1] !== "/") return null;
  const slash = i - 1;
  if (slash > 0 && !/[\s([{"'`]/.test(text[slash - 1]!)) return null;
  return { query: text.slice(i, caret), start: slash };
}

/** Skills matching a typeahead query: name prefix first, then name or description contains it. */
export function matchSkills(skills: readonly KnownSkill[], query: string, limit = 8): KnownSkill[] {
  const q = query.toLowerCase();
  const prefix = skills.filter((s) => s.name.toLowerCase().startsWith(q));
  const rest = skills.filter((s) => !prefix.includes(s) && (s.name.toLowerCase().includes(q) || (q.length > 1 && (s.description ?? "").toLowerCase().includes(q))));
  return [...prefix, ...rest].slice(0, limit);
}
