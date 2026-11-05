// Visual configurator: repositories, routines, general settings and GitHub
// access. Edits drafts locally, then saves through cos_set_config (the same
// JSON documents the server parses) and cos_set_settings (scalar settings).
import { useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { experimental_useRpcQuery, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../rpcContract";
import type { GeneralSettings } from "../../rpcContract";
import type { RepoConfig, Routine, RoutineStep } from "../../src/config";
import { repoKey } from "../../src/config";
import {
  STEP_TYPES,
  blankRepo,
  blankRoutine,
  blankStep,
  loadRepos,
  loadRoutines,
  parseList,
  parseRepoSlug,
  routineHints,
  scheduleMode,
  serializeRepos,
  serializeRoutines,
  splitEvery,
  validateRepos,
  validateRoutines,
} from "../../src/configModel";
import type { ScheduleMode, StepType } from "../../src/configModel";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { STATUS, StatusPill } from "./viz";

type Contract = typeof rpcContract;
type SettingsData = PluginRpcResult<Contract["cos_get_settings"]>;
type Project = SettingsData["projects"][number];
type Provider = SettingsData["providers"][number];

const SECTIONS = [
  { id: "repos", label: "Repositories", icon: "FolderGit2" },
  { id: "routines", label: "Routines", icon: "CalendarClock" },
  { id: "general", label: "General", icon: "SlidersHorizontal" },
  { id: "access", label: "GitHub access", icon: "KeyRound" },
  { id: "advanced", label: "Advanced JSON", icon: "Braces" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

const STEP_META: Record<StepType, { label: string; icon: string; hint: string }> = {
  batch_merge: { label: "Batch merge", icon: "GitMerge", hint: "Merge ready PRs (green CI, approved, own branches by default)." },
  release: { label: "Release", icon: "Tag", hint: "Bump the version, tag and publish a GitHub release." },
  deploy: { label: "Deploy", icon: "Rocket", hint: "Run the deploy command or dispatch a workflow." },
  run_agent: { label: "Run agent", icon: "Bot", hint: "Start an agent thread with a prompt." },
  notify: { label: "Notify", icon: "Bell", hint: "Send a push or webhook notification." },
};

const ALLOW_META: { key: keyof RepoConfig["allow"]; label: string; hint: string; ships: boolean }[] = [
  { key: "intake", label: "Issue intake", hint: "Start agent threads for matching issues.", ships: false },
  { key: "openPr", label: "Open pull requests", hint: "Push branches and open PRs.", ships: false },
  { key: "merge", label: "Merge", hint: "Let batch merge merge PRs.", ships: true },
  { key: "release", label: "Release", hint: "Let routines tag and publish releases.", ships: true },
  { key: "deploy", label: "Deploy", hint: "Let routines run deploys.", ships: true },
];

const CRON_PRESETS = [
  { label: "Every night at 02:00", cron: "0 2 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Mondays at 09:00", cron: "0 9 * * 1" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------- primitives ----------

const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

function Field({ label, hint, children, className, error }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode; className?: string; error?: string | null }) {
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

function TextInput({ id, value, onChange, placeholder, mono, type = "text" }: { id?: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; type?: string }) {
  return <input id={id} type={type} className={cn(inputClass, mono && "font-mono text-xs")} value={value} placeholder={placeholder} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.target.value)} />;
}

/** Number field that tolerates an empty box while typing. */
function NumberInput({ id, value, onChange, min, max }: { id?: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
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
        if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(Math.round(n));
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

/** Comma-separated list editor that keeps the raw text while focused. */
function ListInput({ id, value, onChange, placeholder }: { id?: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
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

function Select<T extends string>({ id, value, onChange, options }: { id?: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <select id={id} className={cn(inputClass, "pr-7")} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
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

function ToggleRow({ label, hint, checked, onChange, accent }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; accent?: ReactNode }) {
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

function Group({ title, icon, children, cols = 2 }: { title: string; icon: string; children: ReactNode; cols?: 1 | 2 | 3 }) {
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

function Problems({ items, tone = "critical" }: { items: string[]; tone?: "critical" | "warning" }) {
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

function ConfirmRemove({ onConfirm, label }: { onConfirm: () => void; label: string }) {
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

// ---------- repositories ----------

function RepoSlugInput({ id, repo, onChange }: { id: string; repo: RepoConfig; onChange: (owner: string, name: string) => void }) {
  const current = repo.owner || repo.repo ? `${repo.owner}/${repo.repo}` : "";
  const [text, setText] = useState(current);
  useEffect(() => {
    if (parseRepoSlug(text)?.owner !== repo.owner || parseRepoSlug(text)?.repo !== repo.repo) setText(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  const parsed = parseRepoSlug(text);
  return (
    <>
      <input
        id={id}
        className={cn(inputClass, "font-mono text-xs")}
        value={text}
        placeholder="owner/repo or GitHub URL"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          const p = parseRepoSlug(e.target.value);
          if (p) onChange(p.owner, p.repo);
          else onChange("", "");
        }}
      />
      {text && !parsed ? <span className="text-[11px]" style={{ color: STATUS.critical }}>Use owner/repo, e.g. acme/app</span> : null}
    </>
  );
}

function ProjectPicker({ id, value, projects, onChange, repo }: { id: string; value: string; projects: Project[]; onChange: (v: string) => void; repo: RepoConfig }) {
  const known = projects.some((p) => p.id === value);
  const [manual, setManual] = useState(Boolean(value) && !known && projects.length > 0);
  const suggestion = useMemo(() => {
    if (value || !repo.owner || !repo.repo) return null;
    const slug = `${repo.owner}/${repo.repo}`.toLowerCase();
    return projects.find((p) => (p.remote ?? "").toLowerCase().replace(/\.git$/, "").endsWith(slug)) ?? null;
  }, [projects, repo.owner, repo.repo, value]);
  if (!projects.length || manual)
    return (
      <div className="flex gap-1.5">
        <TextInput id={id} value={value} onChange={onChange} placeholder="proj_…" mono />
        {projects.length ? (
          <Button size="sm" variant="outline" className="h-8 shrink-0 px-2" onClick={() => setManual(false)}>
            Pick
          </Button>
        ) : null}
      </div>
    );
  return (
    <div className="flex flex-col gap-1">
      <select
        id={id}
        className={cn(inputClass, "pr-7")}
        value={known ? value : ""}
        onChange={(e) => {
          if (e.target.value === "__manual") setManual(true);
          else onChange(e.target.value);
        }}
      >
        <option value="">Choose a BB project…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.remote ? ` (${p.remote.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "")})` : ""}
          </option>
        ))}
        <option value="__manual">Enter a project id…</option>
      </select>
      {suggestion ? (
        <button type="button" className="self-start text-[11px] text-foreground underline underline-offset-2" onClick={() => onChange(suggestion.id)}>
          Use {suggestion.name}, which points at this repository
        </button>
      ) : null}
    </div>
  );
}

function ProviderPicker({ id, value, providers, onChange, allowDefault }: { id: string; value: string; providers: Provider[]; onChange: (v: string) => void; allowDefault: string | null }) {
  const options = [
    ...(allowDefault !== null ? [{ value: "", label: allowDefault }] : []),
    ...providers.filter((p) => p.enabled || p.id === value).map((p) => ({ value: p.id, label: `${p.displayName}${p.available ? "" : " (unavailable)"}` })),
  ];
  if (value && !options.some((o) => o.value === value)) options.push({ value, label: value });
  if (!providers.length) return <TextInput id={id} value={value} onChange={onChange} placeholder="claude-code" mono />;
  return <Select id={id} value={value} onChange={onChange} options={options} />;
}

function AllowBadges({ allow }: { allow: RepoConfig["allow"] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {ALLOW_META.map((a) => (
        <span
          key={a.key}
          className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium", allow[a.key] ? "border-border text-foreground" : "border-dashed border-border text-muted-foreground line-through")}
          title={`${a.label}: ${allow[a.key] ? "allowed" : "not allowed"}`}
        >
          {allow[a.key] ? <span aria-hidden className="size-1.5 rounded-full" style={{ background: a.ships ? STATUS.warning : STATUS.good }} /> : null}
          {a.label}
        </span>
      ))}
    </span>
  );
}

function RepoEditor({ repo, index, problems, open, onToggle, onChange, onRemove, projects, providers, defaultProvider }: { repo: RepoConfig; index: number; problems: string[]; open: boolean; onToggle: () => void; onChange: (r: RepoConfig) => void; onRemove: () => void; projects: Project[]; providers: Provider[]; defaultProvider: string }) {
  const set = <K extends keyof RepoConfig>(key: K, value: RepoConfig[K]) => onChange({ ...repo, [key]: value });
  const project = projects.find((p) => p.id === repo.projectId);
  const title = repo.owner && repo.repo ? repoKey(repo) : `Repository ${index + 1}`;
  const placeholder = repo.owner === "owner" && repo.repo === "repo";
  return (
    <article className={cn("rounded-lg border bg-background", problems.length ? "border-destructive/60" : "border-border")}>
      <header className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle} aria-expanded={open}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} fallback="Circle" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Icon name="Github" fallback="FolderGit2" className="size-4 shrink-0 text-foreground" aria-hidden />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {project ? `Project ${project.name}` : repo.projectId ? `Project ${repo.projectId}` : "No project selected"} · labels {repo.issueFilter.labels.length ? repo.issueFilter.labels.join(", ") : "any"} · up to {repo.maxConcurrent} agents
            </span>
          </span>
        </button>
        {placeholder ? <StatusPill tone="warning" label="Placeholder, ignored" /> : problems.length ? <StatusPill tone="critical" label={`${problems.length} to fix`} /> : null}
        <AllowBadges allow={repo.allow} />
        <ConfirmRemove label={`Remove ${title}`} onConfirm={onRemove} />
      </header>
      {open ? (
        <div className="flex flex-col gap-5 border-t border-border px-3 py-4">
          <Problems items={problems} />
          <Group title="Source" icon="FolderGit2">
            <Field label="GitHub repository">{(id) => <RepoSlugInput id={id} repo={repo} onChange={(owner, name) => onChange({ ...repo, owner, repo: name })} />}</Field>
            <Field label="BB project" hint="The project whose checkout agents work in. Project ids are specific to this bb.">
              {(id) => <ProjectPicker id={id} value={repo.projectId} projects={projects} repo={repo} onChange={(v) => set("projectId", v)} />}
            </Field>
          </Group>
          <Group title="What runs here" icon="ShieldCheck" cols={1}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ALLOW_META.map((a) => (
                <ToggleRow
                  key={a.key}
                  label={a.label}
                  hint={a.hint}
                  checked={repo.allow[a.key]}
                  onChange={(v) => set("allow", { ...repo.allow, [a.key]: v })}
                  accent={a.ships ? <span className="rounded-sm px-1 text-[10px] font-semibold" style={{ color: STATUS.serious, border: `1px solid ${STATUS.serious}` }}>ships</span> : null}
                />
              ))}
            </div>
          </Group>
          <Group title="Issue intake" icon="Inbox" cols={3}>
            <Field label="Issue labels" hint="Issues must carry all of these. Comma separated.">{(id) => <ListInput id={id} value={repo.issueFilter.labels} onChange={(v) => set("issueFilter", { ...repo.issueFilter, labels: v })} placeholder="agent-ready" />}</Field>
            <Field label="Assignee" hint="Optional GitHub login.">{(id) => <TextInput id={id} value={repo.issueFilter.assignee ?? ""} onChange={(v) => set("issueFilter", { ...repo.issueFilter, assignee: v })} placeholder="any" />}</Field>
            <Field label="Milestone" hint="Optional milestone title.">{(id) => <TextInput id={id} value={repo.issueFilter.milestone ?? ""} onChange={(v) => set("issueFilter", { ...repo.issueFilter, milestone: v })} placeholder="any" />}</Field>
            <Field label="Max concurrent agents">{(id) => <NumberInput id={id} value={repo.maxConcurrent} min={0} max={50} onChange={(v) => set("maxConcurrent", v)} />}</Field>
            <Field label="Branch prefix">{(id) => <TextInput id={id} value={repo.branchPrefix} onChange={(v) => set("branchPrefix", v)} mono />}</Field>
            <Field label="Rename branches" hint="Name branches after the issue.">
              {() => (
                <div className="flex h-8 items-center">
                  <Switch checked={repo.renameBranch} onChange={(v) => set("renameBranch", v)} label="Rename branches" />
                </div>
              )}
            </Field>
          </Group>
          <Group title="Agent" icon="Bot" cols={3}>
            <Field label="Provider">{(id) => <ProviderPicker id={id} value={repo.providerId ?? ""} providers={providers} allowDefault={`Default (${defaultProvider || "bb default"})`} onChange={(v) => set("providerId", v)} />}</Field>
            <Field label="Model" hint="Empty uses the default model.">{(id) => <TextInput id={id} value={repo.model ?? ""} onChange={(v) => set("model", v)} placeholder="default" />}</Field>
            <Field label="Permission mode">
              {(id) => (
                <Select
                  id={id}
                  value={repo.permissionMode}
                  onChange={(v) => set("permissionMode", v)}
                  options={[
                    { value: "accept-edits", label: "Accept edits" },
                    { value: "auto", label: "Auto" },
                    { value: "full", label: "Full access" },
                  ]}
                />
              )}
            </Field>
          </Group>
          <Group title="Pull requests" icon="GitPullRequest" cols={3}>
            <Field label="Check command" hint="Runs before a PR opens; failures go back to the agent.">{(id) => <TextInput id={id} value={repo.checkCommand ?? ""} onChange={(v) => set("checkCommand", v)} placeholder="npm test" mono />}</Field>
            <Field label="Reviewers" hint="GitHub logins, comma separated.">{(id) => <ListInput id={id} value={repo.reviewers} onChange={(v) => set("reviewers", v)} />}</Field>
            <Field label="PR labels">{(id) => <ListInput id={id} value={repo.labels} onChange={(v) => set("labels", v)} />}</Field>
          </Group>
          <Group title="Merging" icon="GitMerge" cols={3}>
            <Field label="Merge strategy">
              {(id) => (
                <Select id={id} value={repo.mergeStrategy} onChange={(v) => set("mergeStrategy", v)} options={[{ value: "squash", label: "Squash" }, { value: "merge", label: "Merge commit" }, { value: "rebase", label: "Rebase" }]} />
              )}
            </Field>
            <Field label="On conflicts">
              {(id) => (
                <Select id={id} value={repo.conflictHandling} onChange={(v) => set("conflictHandling", v)} options={[{ value: "skip", label: "Skip the PR" }, { value: "rebase-via-agent", label: "Ask an agent to rebase" }]} />
              )}
            </Field>
            <Field label="Merge only PRs with labels" hint="Optional, comma separated.">{(id) => <ListInput id={id} value={repo.mergeFilter.labels} onChange={(v) => set("mergeFilter", { ...repo.mergeFilter, labels: v })} />}</Field>
            <ToggleRow label="Only this plugin's branches" hint={`Branches starting with ${repo.branchPrefix}`} checked={repo.mergeFilter.onlyOwnBranches} onChange={(v) => set("mergeFilter", { ...repo.mergeFilter, onlyOwnBranches: v })} />
            <ToggleRow label="Require approval" hint="An approving review is needed." checked={repo.mergeFilter.requireApproval} onChange={(v) => set("mergeFilter", { ...repo.mergeFilter, requireApproval: v })} />
          </Group>
          <Group title="Release and deploy" icon="Rocket" cols={3}>
            <Field label="Version bump">
              {(id) => (
                <Select
                  id={id}
                  value={repo.versionStrategy}
                  onChange={(v) => set("versionStrategy", v)}
                  options={[
                    { value: "patch", label: "Patch" },
                    { value: "minor", label: "Minor" },
                    { value: "major", label: "Major" },
                    { value: "conventional", label: "From conventional commits" },
                    { value: "calver", label: "Calendar version" },
                  ]}
                />
              )}
            </Field>
            <Field label="Version file">{(id) => <TextInput id={id} value={repo.versionFile} onChange={(v) => set("versionFile", v)} mono />}</Field>
            <Field label="Tag prefix">{(id) => <TextInput id={id} value={repo.tagPrefix} onChange={(v) => set("tagPrefix", v)} mono />}</Field>
            <Field label="Deploy command" hint="Runs in the checkout.">{(id) => <TextInput id={id} value={repo.deployCommand ?? ""} onChange={(v) => set("deployCommand", v)} placeholder="./scripts/deploy.sh" mono />}</Field>
            <Field label="Deploy workflow" hint="Or a GitHub Actions file to dispatch.">{(id) => <TextInput id={id} value={repo.deployWorkflow ?? ""} onChange={(v) => set("deployWorkflow", v)} placeholder="deploy.yml" mono />}</Field>
          </Group>
        </div>
      ) : null}
    </article>
  );
}

// ---------- routines ----------

function StepEditor({ step, index, count, onChange, onMove, onRemove, providers }: { step: RoutineStep; index: number; count: number; onChange: (s: RoutineStep) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void; providers: Provider[] }) {
  const meta = STEP_META[step.type];
  let body: ReactNode = null;
  switch (step.type) {
    case "batch_merge":
      body = (
        <>
          <Field label="Strategy">
            {(id) => (
              <Select
                id={id}
                value={step.strategy ?? ""}
                onChange={(v) => onChange({ ...step, strategy: v || undefined } as RoutineStep)}
                options={[{ value: "", label: "Repository default" }, { value: "squash", label: "Squash" }, { value: "merge", label: "Merge commit" }, { value: "rebase", label: "Rebase" }]}
              />
            )}
          </Field>
          <Field label="Only PRs with labels">{(id) => <ListInput id={id} value={step.labels ?? []} onChange={(v) => onChange({ ...step, labels: v })} />}</Field>
        </>
      );
      break;
    case "release":
      body = (
        <>
          <Field label="Version bump">
            {(id) => (
              <Select
                id={id}
                value={step.strategy ?? ""}
                onChange={(v) => onChange({ ...step, strategy: v || undefined } as RoutineStep)}
                options={[{ value: "", label: "Repository default" }, { value: "patch", label: "Patch" }, { value: "minor", label: "Minor" }, { value: "major", label: "Major" }, { value: "conventional", label: "Conventional commits" }, { value: "calver", label: "Calendar version" }]}
              />
            )}
          </Field>
          <ToggleRow label="Draft release" checked={step.draft} onChange={(v) => onChange({ ...step, draft: v })} />
        </>
      );
      break;
    case "deploy":
      body = (
        <>
          <Field label="Command" hint="Empty uses the repository's deploy command.">{(id) => <TextInput id={id} value={step.command ?? ""} onChange={(v) => onChange({ ...step, command: v })} mono />}</Field>
          <Field label="Workflow" hint="Empty uses the repository's workflow.">{(id) => <TextInput id={id} value={step.workflow ?? ""} onChange={(v) => onChange({ ...step, workflow: v })} mono />}</Field>
          <Field label="Git ref">{(id) => <TextInput id={id} value={step.ref ?? ""} onChange={(v) => onChange({ ...step, ref: v })} placeholder="default branch" mono />}</Field>
          <Field label="Timeout (minutes)">{(id) => <NumberInput id={id} value={step.pollTimeoutMinutes} min={1} onChange={(v) => onChange({ ...step, pollTimeoutMinutes: Math.max(1, v) })} />}</Field>
        </>
      );
      break;
    case "run_agent":
      body = (
        <>
          <Field label="Prompt" className="sm:col-span-2">
            {(id) => <textarea id={id} className={cn(inputClass, "h-20 py-1.5")} value={step.prompt} onChange={(e) => onChange({ ...step, prompt: e.target.value })} placeholder="Triage new issues and label the ones that are ready for an agent." />}
          </Field>
          <Field label="Thread title">{(id) => <TextInput id={id} value={step.title ?? ""} onChange={(v) => onChange({ ...step, title: v })} placeholder="optional" />}</Field>
          <Field label="Provider">{(id) => <ProviderPicker id={id} value={step.providerId ?? ""} providers={providers} allowDefault="Default" onChange={(v) => onChange({ ...step, providerId: v })} />}</Field>
          <Field label="Model">{(id) => <TextInput id={id} value={step.model ?? ""} onChange={(v) => onChange({ ...step, model: v })} placeholder="default" />}</Field>
          <Field label="Wait for it (minutes)" hint="0 starts it and moves on.">{(id) => <NumberInput id={id} value={step.waitMinutes} min={0} onChange={(v) => onChange({ ...step, waitMinutes: Math.max(0, v) })} />}</Field>
        </>
      );
      break;
    case "notify":
      body = (
        <>
          <Field label="Title">{(id) => <TextInput id={id} value={step.title} onChange={(v) => onChange({ ...step, title: v })} placeholder="Nightly ship done" />}</Field>
          <Field label="Body">{(id) => <TextInput id={id} value={step.body ?? ""} onChange={(v) => onChange({ ...step, body: v })} placeholder="optional" />}</Field>
        </>
      );
      break;
  }
  return (
    <li className="flex gap-3 rounded-md border border-border bg-card p-3">
      <div className="flex flex-col items-center gap-1">
        <span className="flex size-7 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold tabular-nums text-foreground">{index + 1}</span>
        {index < count - 1 ? <span aria-hidden className="w-px flex-1 bg-border" /> : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Icon name={meta.icon} fallback="Circle" className="size-4" aria-hidden />
              {meta.label}
            </div>
            <div className="text-[11px] text-muted-foreground">{meta.hint}</div>
          </div>
          <div className="flex items-center gap-0.5">
            <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move step up">
              <Icon name="ArrowUp" fallback="Circle" aria-hidden />
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move step down">
              <Icon name="ArrowDown" fallback="Circle" aria-hidden />
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-1.5 text-muted-foreground" disabled={count === 1} onClick={onRemove} aria-label="Remove step">
              <Icon name="X" fallback="Circle" aria-hidden />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{body}</div>
      </div>
    </li>
  );
}

const TIMEZONES: string[] = (() => {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();

function ScheduleEditor({ routine, onChange }: { routine: Routine; onChange: (r: Routine) => void }) {
  const mode = scheduleMode(routine);
  const every = splitEvery(routine.every);
  const tzList = useId();
  const setMode = (m: ScheduleMode) => {
    const { cron: _c, every: _e, timezone: _t, ...rest } = routine;
    if (m === "manual") onChange(rest as Routine);
    else if (m === "every") onChange({ ...rest, every: routine.every ?? "1d" } as Routine);
    else onChange({ ...rest, cron: routine.cron ?? "0 2 * * *", ...(routine.timezone ? { timezone: routine.timezone } : {}) } as Routine);
  };
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex w-fit rounded-md border border-border p-0.5" role="radiogroup" aria-label="Schedule type">
        {(
          [
            ["manual", "Manual only"],
            ["every", "Repeat every"],
            ["cron", "Cron schedule"],
          ] as const
        ).map(([m, label]) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cn("rounded px-2.5 py-1 text-xs font-medium", mode === m ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {label}
          </button>
        ))}
      </div>
      {mode === "every" ? (
        <div className="flex items-center gap-2">
          <div className="w-24">
            <NumberInput value={every.amount} min={1} onChange={(v) => onChange({ ...routine, every: `${Math.max(1, v)}${every.unit}` })} />
          </div>
          <div className="w-32">
            <Select value={every.unit} onChange={(u) => onChange({ ...routine, every: `${every.amount}${u}` })} options={[{ value: "m", label: "minutes" }, { value: "h", label: "hours" }, { value: "d", label: "days" }]} />
          </div>
        </div>
      ) : null}
      {mode === "cron" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Cron expression" hint="minute hour day month weekday">{(id) => <TextInput id={id} value={routine.cron ?? ""} onChange={(v) => onChange({ ...routine, cron: v })} mono />}</Field>
          <Field label="Preset">
            {(id) => (
              <select id={id} className={cn(inputClass, "pr-7")} value={CRON_PRESETS.some((p) => p.cron === routine.cron) ? routine.cron : ""} onChange={(e) => e.target.value && onChange({ ...routine, cron: e.target.value })}>
                <option value="">Custom</option>
                {CRON_PRESETS.map((p) => (
                  <option key={p.cron} value={p.cron}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Timezone" hint="Empty uses the server's local time.">
            {(id) => (
              <>
                <input id={id} list={tzList} className={inputClass} value={routine.timezone ?? ""} placeholder="e.g. Europe/Bucharest" onChange={(e) => onChange({ ...routine, timezone: e.target.value })} />
                <datalist id={tzList}>
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function RoutineEditor({ routine, problems, hints, repos, open, onToggle, onChange, onRemove, providers }: { routine: Routine; problems: string[]; hints: string[]; repos: RepoConfig[]; open: boolean; onToggle: () => void; onChange: (r: Routine) => void; onRemove: () => void; providers: Provider[] }) {
  const repoOptions = repos.filter((r) => r.owner && r.repo).map((r) => ({ value: repoKey(r), label: repoKey(r) }));
  if (!repoOptions.some((o) => o.value === routine.repo)) repoOptions.unshift({ value: routine.repo, label: `${routine.repo} (not configured)` });
  const [adding, setAdding] = useState(false);
  const schedule = routine.cron ? `cron ${routine.cron}${routine.timezone ? ` ${routine.timezone}` : ""}` : routine.every ? `every ${routine.every}` : "manual only";
  return (
    <article className={cn("rounded-lg border bg-background", problems.length ? "border-destructive/60" : "border-border")}>
      <header className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle} aria-expanded={open}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} fallback="Circle" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">{routine.name || "Untitled routine"}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {routine.repo} · {schedule} · {routine.steps.map((s) => STEP_META[s.type].label).join(" → ")}
            </span>
          </span>
        </button>
        {problems.length ? <StatusPill tone="critical" label={`${problems.length} to fix`} /> : null}
        {routine.dryRun ? <StatusPill tone="info" icon="Eye" label="Dry run" /> : null}
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {routine.enabled ? "On" : "Off"}
          <Switch checked={routine.enabled} onChange={(v) => onChange({ ...routine, enabled: v })} label={routine.enabled ? "Disable routine" : "Enable routine"} />
        </span>
        <ConfirmRemove label={`Remove ${routine.name}`} onConfirm={onRemove} />
      </header>
      {open ? (
        <div className="flex flex-col gap-5 border-t border-border px-3 py-4">
          <Problems items={problems} />
          <Problems items={hints} tone="warning" />
          <Group title="Basics" icon="FileText" cols={2}>
            <Field label="Name" hint="Letters, numbers, spaces, dots, dashes.">{(id) => <TextInput id={id} value={routine.name} onChange={(v) => onChange({ ...routine, name: v })} />}</Field>
            <Field label="Repository">{(id) => <Select id={id} value={routine.repo} onChange={(v) => onChange({ ...routine, repo: v })} options={repoOptions} />}</Field>
            <ToggleRow label="Dry run" hint="Plan and report only; nothing is merged, tagged or deployed." checked={routine.dryRun} onChange={(v) => onChange({ ...routine, dryRun: v })} />
            <ToggleRow label="Continue after a failed step" checked={routine.continueOnError} onChange={(v) => onChange({ ...routine, continueOnError: v })} />
          </Group>
          <Group title="Schedule" icon="Clock" cols={1}>
            <ScheduleEditor routine={routine} onChange={onChange} />
          </Group>
          <Group title="Steps" icon="ListOrdered" cols={1}>
            <ol className="flex flex-col gap-2">
              {routine.steps.map((step, i) => (
                <StepEditor
                  key={i}
                  step={step}
                  index={i}
                  count={routine.steps.length}
                  providers={providers}
                  onChange={(s) => onChange({ ...routine, steps: routine.steps.map((x, j) => (j === i ? s : x)) })}
                  onRemove={() => onChange({ ...routine, steps: routine.steps.filter((_, j) => j !== i) })}
                  onMove={(dir) => {
                    const steps = [...routine.steps];
                    const [moved] = steps.splice(i, 1);
                    steps.splice(i + dir, 0, moved!);
                    onChange({ ...routine, steps });
                  }}
                />
              ))}
            </ol>
            {adding ? (
              <div className="flex flex-wrap gap-1.5">
                {STEP_TYPES.map((t) => (
                  <Button
                    key={t}
                    size="sm"
                    variant="outline"
                    className="h-7 px-2"
                    onClick={() => {
                      onChange({ ...routine, steps: [...routine.steps, blankStep(t)] });
                      setAdding(false);
                    }}
                  >
                    <Icon name={STEP_META[t].icon} fallback="Circle" aria-hidden /> {STEP_META[t].label}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="h-7 w-fit px-2" onClick={() => setAdding(true)}>
                <Icon name="Plus" fallback="Circle" aria-hidden /> Add step
              </Button>
            )}
          </Group>
        </div>
      ) : null}
    </article>
  );
}

// ---------- general + access ----------

function GeneralEditor({ values, onChange, providers }: { values: GeneralSettings; onChange: (v: GeneralSettings) => void; providers: Provider[] }) {
  const set = <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => onChange({ ...values, [key]: value });
  const webhookError = values.notifyWebhookUrl && !/^https:\/\/\S+$/.test(values.notifyWebhookUrl) ? "Must start with https://" : null;
  return (
    <div className="flex flex-col gap-5">
      <Group title="Capacity" icon="Gauge" cols={3}>
        <Field label="Max agents across all repos">{(id) => <NumberInput id={id} value={values.maxConcurrentTotal} min={0} max={100} onChange={(v) => set("maxConcurrentTotal", v)} />}</Field>
        <Field label="Intake every (minutes)">{(id) => <NumberInput id={id} value={values.intakeIntervalMinutes} min={1} max={1440} onChange={(v) => set("intakeIntervalMinutes", v)} />}</Field>
        <Field label="Poll CI every (minutes)">{(id) => <NumberInput id={id} value={values.ciPollIntervalMinutes} min={1} max={120} onChange={(v) => set("ciPollIntervalMinutes", v)} />}</Field>
      </Group>
      <Group title="Recovery" icon="LifeBuoy" cols={3}>
        <Field label="Stalled after (minutes)" hint="No activity for this long marks an agent stalled.">{(id) => <NumberInput id={id} value={values.stallThresholdMinutes} min={1} max={1440} onChange={(v) => set("stallThresholdMinutes", v)} />}</Field>
        <Field label="Fix cycles per issue" hint="Failing checks are sent back this many times.">{(id) => <NumberInput id={id} value={values.maxFixRetries} min={0} max={10} onChange={(v) => set("maxFixRetries", v)} />}</Field>
        <ToggleRow label="Auto-retry stalled agents once" checked={values.autoRetryStalled} onChange={(v) => set("autoRetryStalled", v)} />
      </Group>
      <Group title="Default agent" icon="Bot" cols={2}>
        <Field label="Provider">{(id) => <ProviderPicker id={id} value={values.defaultProviderId} providers={providers} allowDefault="bb default" onChange={(v) => set("defaultProviderId", v)} />}</Field>
        <Field label="Model" hint="Empty uses the provider's default.">{(id) => <TextInput id={id} value={values.defaultModel} onChange={(v) => set("defaultModel", v)} placeholder="default" />}</Field>
      </Group>
      <Group title="Notifications" icon="Bell" cols={2}>
        <ToggleRow label="BB push notifications" hint="Uses the push-notifications plugin when installed." checked={values.notifyPush} onChange={(v) => set("notifyPush", v)} />
        <Field label="Webhook URL" hint="Receives JSON {title, body, threadId} for every alert." error={webhookError}>
          {(id) => <TextInput id={id} value={values.notifyWebhookUrl} onChange={(v) => set("notifyWebhookUrl", v)} placeholder="https://…" mono />}
        </Field>
      </Group>
    </div>
  );
}

function AccessEditor({ token, onSaved }: { token: SettingsData["token"]; onSaved: () => Promise<void> }) {
  const rpc = useRpc<Contract>();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const source = token.source === "setting" ? { tone: "good" as const, label: "Using the stored token" } : token.source === "gh-cli" ? { tone: "good" as const, label: "Using gh auth on the server" } : { tone: "critical" as const, label: "No GitHub credentials" };
  const run = async (input: { githubToken: string } | { clearGithubToken: true }, done: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await rpc.call("cos_set_settings", input);
      setValue("");
      setStatus({ ok: true, text: done });
      await onSaved();
    } catch (error) {
      setStatus({ ok: false, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={source.tone} label={source.label} />
        {token.stored ? <StatusPill tone="neutral" icon="Lock" label="Token stored (hidden)" /> : null}
      </div>
      <p className="max-w-2xl text-xs text-muted-foreground">
        Leave this empty to use <code className="font-mono">gh auth token</code> from the server host. A stored token is write-only: it is never shown, sent back to the browser, or logged. It needs repo and workflow scope on every configured repository.
      </p>
      <form
        className="flex max-w-xl flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void run({ githubToken: value.trim() }, "Token saved.");
        }}
      >
        <Field label={token.stored ? "Replace token" : "GitHub token"} className="min-w-64 flex-1">
          {(id) => <TextInput id={id} type="password" value={value} onChange={setValue} placeholder="ghp_… or github_pat_…" mono />}
        </Field>
        <Button size="sm" type="submit" disabled={busy || !value.trim()}>
          <Icon name="Save" fallback="Circle" aria-hidden /> Save token
        </Button>
        {token.stored ? (
          <Button size="sm" type="button" variant="outline" disabled={busy} onClick={() => void run({ clearGithubToken: true }, "Stored token removed.")}>
            Remove stored token
          </Button>
        ) : null}
      </form>
      {status ? <p className="text-xs" style={{ color: status.ok ? STATUS.good : STATUS.critical }}>{status.text}</p> : null}
    </div>
  );
}

function AdvancedEditor({ repos, routines, locked, onSaved }: { repos: string; routines: string; locked: boolean; onSaved: () => Promise<void> }) {
  const rpc = useRpc<Contract>();
  const [r, setR] = useState<string | null>(null);
  const [t, setT] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    setStatus(null);
    try {
      const result = await rpc.call("cos_set_config", { ...(r !== null ? { repos: r } : {}), ...(t !== null ? { routines: t } : {}) });
      setStatus({ ok: true, text: result.warnings.length ? `Saved. ${result.warnings.join("; ")}` : "Saved." });
      setR(null);
      setT(null);
      await onSaved();
    } catch (error) {
      setStatus({ ok: false, text: errorText(error) });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">The raw documents behind the visual editor. Useful for copying a setup to another bb or bulk edits. Saving validates both documents.</p>
      {locked ? <Problems tone="warning" items={["You have unsaved visual changes. Save or discard them before editing the JSON."]} /> : null}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Field label="Repositories">{(id) => <textarea id={id} disabled={locked} className="min-h-72 w-full rounded-md border border-input bg-transparent p-2 font-mono text-xs text-foreground disabled:opacity-50" value={r ?? repos} onChange={(e) => setR(e.target.value)} spellCheck={false} />}</Field>
        <Field label="Routines">{(id) => <textarea id={id} disabled={locked} className="min-h-72 w-full rounded-md border border-input bg-transparent p-2 font-mono text-xs text-foreground disabled:opacity-50" value={t ?? routines} onChange={(e) => setT(e.target.value)} spellCheck={false} />}</Field>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={locked || (r === null && t === null)} onClick={() => void save()}>
          Save JSON
        </Button>
        <Button size="sm" variant="outline" disabled={r === null && t === null} onClick={() => (setR(null), setT(null), setStatus(null))}>
          Revert
        </Button>
        {status ? <span className="text-xs" style={{ color: status.ok ? STATUS.good : STATUS.critical }}>{status.text}</span> : null}
      </div>
    </div>
  );
}

// ---------- root ----------

function generalDiff(a: GeneralSettings, b: GeneralSettings): Partial<GeneralSettings> {
  const out: Partial<GeneralSettings> = {};
  for (const k of Object.keys(b) as (keyof GeneralSettings)[]) if (a[k] !== b[k]) (out as Record<string, unknown>)[k] = b[k];
  return out;
}

export function Configurator({ initialSection = "repos", compact = false }: { initialSection?: Section; compact?: boolean }) {
  const rpc = useRpc<Contract>();
  const config = experimental_useRpcQuery<Contract, "cos_get_config">({ contract: rpcContract, method: "cos_get_config", input: null });
  const settings = experimental_useRpcQuery<Contract, "cos_get_settings">({ contract: rpcContract, method: "cos_get_settings", input: null });
  const [section, setSection] = useState<Section>(initialSection);
  const [repos, setRepos] = useState<RepoConfig[] | null>(null);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [general, setGeneral] = useState<GeneralSettings | null>(null);
  const [openRepo, setOpenRepo] = useState<number | null>(null);
  const [openRoutine, setOpenRoutine] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const loadedRepos = useMemo(() => (config.data ? loadRepos(config.data.repos) : null), [config.data]);
  const loadedRoutines = useMemo(() => (config.data ? loadRoutines(config.data.routines) : null), [config.data]);
  const loadedGeneral = settings.data?.values ?? null;

  const repoDraft = repos ?? (loadedRepos?.ok ? loadedRepos.items : []);
  const routineDraft = routines ?? (loadedRoutines?.ok ? loadedRoutines.items : []);
  const generalDraft = general ?? loadedGeneral;
  const generalChanges = loadedGeneral && general ? generalDiff(loadedGeneral, general) : {};
  const dirty = { repos: repos !== null, routines: routines !== null, general: Object.keys(generalChanges).length > 0 };
  const anyDirty = dirty.repos || dirty.routines || dirty.general;

  const repoIssues = useMemo(() => validateRepos(repoDraft), [repoDraft]);
  const routineIssues = useMemo(() => validateRoutines(routineDraft), [routineDraft]);
  const problemCount = Object.keys(repoIssues).length + Object.keys(routineIssues).length + (general?.notifyWebhookUrl && !/^https:\/\/\S+$/.test(general.notifyWebhookUrl) ? 1 : 0);

  const refetchAll = async () => {
    await Promise.all([config.refetch(), settings.refetch()]);
  };
  useRealtime("cos-changed", () => {
    if (!anyDirty) void refetchAll();
  });

  const discard = () => {
    setRepos(null);
    setRoutines(null);
    setGeneral(null);
    setStatus(null);
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const warnings: string[] = [];
      if (dirty.repos || dirty.routines) {
        const result = await rpc.call("cos_set_config", { ...(dirty.repos ? { repos: serializeRepos(repoDraft) } : {}), ...(dirty.routines ? { routines: serializeRoutines(routineDraft) } : {}) });
        warnings.push(...result.warnings);
      }
      if (dirty.general) await rpc.call("cos_set_settings", generalChanges);
      await refetchAll();
      setRepos(null);
      setRoutines(null);
      setGeneral(null);
      setStatus({ ok: true, text: warnings.length ? `Saved. ${warnings.join("; ")}` : "Saved. Changes apply on the next intake and sweep." });
    } catch (error) {
      setStatus({ ok: false, text: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const projects = settings.data?.projects ?? [];
  const providers = settings.data?.providers ?? [];
  const counts: Record<Section, number | null> = { repos: repoDraft.length, routines: routineDraft.length, general: null, access: null, advanced: null };
  const sectionDirty: Record<Section, boolean> = { repos: dirty.repos, routines: dirty.routines, general: dirty.general, access: false, advanced: false };
  const loadError = (loadedRepos && !loadedRepos.ok ? `Repositories JSON: ${loadedRepos.error}` : null) ?? (loadedRoutines && !loadedRoutines.ok ? `Routines JSON: ${loadedRoutines.error}` : null);

  if (config.error || settings.error) return <Problems items={[errorText(config.error ?? settings.error)]} />;
  if (!config.data || !settings.data || !generalDraft) return <p className="text-sm text-muted-foreground">Loading configuration…</p>;

  return (
    <div className={cn("flex flex-col gap-4", compact ? "" : "lg:flex-row lg:items-start")}>
      <nav className={cn("flex gap-1 overflow-x-auto", compact ? "flex-row" : "flex-row lg:w-52 lg:shrink-0 lg:flex-col")} aria-label="Configuration sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-current={section === s.id ? "page" : undefined}
            onClick={() => setSection(s.id)}
            className={cn("flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors", section === s.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground")}
          >
            <Icon name={s.icon} fallback="Circle" className="size-4" aria-hidden />
            <span className="flex-1">{s.label}</span>
            {counts[s.id] !== null ? <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{counts[s.id]}</span> : null}
            {sectionDirty[s.id] ? <span aria-label="unsaved" className="size-1.5 rounded-full" style={{ background: STATUS.warning }} /> : null}
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {loadError && section !== "advanced" ? (
          <Problems items={[`${loadError}. Fix it in Advanced JSON; the visual editor shows the last valid parts only.`]} />
        ) : null}
        {section === "repos" ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">Each repository is watched independently, with its own labels, limits and permissions. Anything that ships code (merge, release, deploy) is off until you turn it on.</p>
              <Button
                size="sm"
                onClick={() => {
                  setRepos([...repoDraft, blankRepo(projects.length === 1 ? projects[0]!.id : "")]);
                  setOpenRepo(repoDraft.length);
                  setSection("repos");
                }}
              >
                <Icon name="Plus" fallback="Circle" aria-hidden /> Add repository
              </Button>
            </div>
            {repoDraft.length ? (
              repoDraft.map((repo, i) => (
                <RepoEditor
                  key={i}
                  repo={repo}
                  index={i}
                  problems={repoIssues[i] ?? []}
                  open={openRepo === i}
                  onToggle={() => setOpenRepo(openRepo === i ? null : i)}
                  onChange={(r) => setRepos(repoDraft.map((x, j) => (j === i ? r : x)))}
                  onRemove={() => {
                    setRepos(repoDraft.filter((_, j) => j !== i));
                    setOpenRepo(null);
                  }}
                  projects={projects}
                  providers={providers}
                  defaultProvider={generalDraft.defaultProviderId}
                />
              ))
            ) : (
              <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-8 text-center">
                <Icon name="FolderGit2" fallback="Circle" className="size-6 text-muted-foreground" aria-hidden />
                <p className="text-sm font-medium text-foreground">No repositories yet</p>
                <p className="max-w-md text-xs text-muted-foreground">Add a GitHub repository and the BB project that holds its checkout. Add as many as you like.</p>
              </div>
            )}
          </>
        ) : null}
        {section === "routines" ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">Routines chain steps on a schedule for one repository. New routines start disabled and in dry run.</p>
              <Button
                size="sm"
                disabled={!repoDraft.some((r) => r.owner && r.repo)}
                onClick={() => {
                  const first = repoDraft.find((r) => r.owner && r.repo)!;
                  setRoutines([...routineDraft, blankRoutine(repoKey(first), routineDraft.map((r) => r.name))]);
                  setOpenRoutine(routineDraft.length);
                }}
              >
                <Icon name="Plus" fallback="Circle" aria-hidden /> Add routine
              </Button>
            </div>
            {routineDraft.length ? (
              routineDraft.map((routine, i) => (
                <RoutineEditor
                  key={i}
                  routine={routine}
                  problems={routineIssues[i] ?? []}
                  hints={routineHints(routine, repoDraft)}
                  repos={repoDraft}
                  open={openRoutine === i}
                  onToggle={() => setOpenRoutine(openRoutine === i ? null : i)}
                  onChange={(r) => setRoutines(routineDraft.map((x, j) => (j === i ? r : x)))}
                  onRemove={() => {
                    setRoutines(routineDraft.filter((_, j) => j !== i));
                    setOpenRoutine(null);
                  }}
                  providers={providers}
                />
              ))
            ) : (
              <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-8 text-center">
                <Icon name="CalendarClock" fallback="Circle" className="size-6 text-muted-foreground" aria-hidden />
                <p className="text-sm font-medium text-foreground">No routines yet</p>
                <p className="max-w-md text-xs text-muted-foreground">Example: every night, batch merge green PRs, cut a patch release, then deploy.</p>
              </div>
            )}
          </>
        ) : null}
        {section === "general" ? <GeneralEditor values={generalDraft} onChange={setGeneral} providers={providers} /> : null}
        {section === "access" ? <AccessEditor token={settings.data.token} onSaved={refetchAll} /> : null}
        {section === "advanced" ? <AdvancedEditor repos={config.data.repos} routines={config.data.routines} locked={anyDirty} onSaved={refetchAll} /> : null}

        {anyDirty || status ? (
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-sm">
            {anyDirty ? (
              <>
                <span className="flex items-center gap-1.5 text-sm text-foreground">
                  <span aria-hidden className="size-2 rounded-full" style={{ background: STATUS.warning }} />
                  Unsaved changes
                  {problemCount ? <span className="text-xs" style={{ color: STATUS.critical }}>· {problemCount} {problemCount === 1 ? "entry needs" : "entries need"} fixing</span> : null}
                </span>
                <span className="ml-auto flex gap-1.5">
                  <Button size="sm" variant="outline" disabled={saving} onClick={discard}>
                    Discard
                  </Button>
                  <Button size="sm" disabled={saving || problemCount > 0} onClick={() => void save()}>
                    <Icon name="Save" fallback="Circle" aria-hidden /> {saving ? "Saving…" : "Save changes"}
                  </Button>
                </span>
              </>
            ) : null}
            {status ? (
              <span className={cn("text-xs", anyDirty && "basis-full")} style={{ color: status.ok ? STATUS.good : STATUS.critical }}>
                {status.text}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
