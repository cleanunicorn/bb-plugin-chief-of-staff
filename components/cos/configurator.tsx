// Visual configurator: the delivery workflow, repositories, general settings
// and GitHub access. Edits drafts locally, then saves through cos_set_config (the same
// JSON documents the server parses) and cos_set_settings (scalar settings).
import { useEffect, useMemo, useState } from "react";
import { experimental_useRpcQuery, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../rpcContract";
import type { GeneralSettings } from "../../rpcContract";
import type { RepoConfig } from "../../src/config";
import { isPlaceholderRepo, repoKey } from "../../src/config";
import { blankRepo, inferIdentity, loadRepos, parseRepoSlug, selectProject, serializeRepos, validateRepos } from "../../src/configModel";
import { DEFAULT_DOCUMENT, parseWorkflows, serializeWorkflows, validateDocument } from "../../src/workflow";
import type { WorkflowsDocument } from "../../src/workflow";
import { WorkflowsEditor } from "./workflowEditor";
import { Button } from "../ui/button";
import { Field, TextInput, NumberInput, ListInput, Select, ToggleRow, Group, Problems, ConfirmRemove, inputClass } from "./fields";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { STATUS, StatusPill } from "./viz";

type Contract = typeof rpcContract;
type SettingsData = PluginRpcResult<Contract["cos_get_settings"]>;
type Project = SettingsData["projects"][number];
type Provider = SettingsData["providers"][number];

const SECTIONS = [
  { id: "workflow", label: "Workflows", icon: "Workflow" },
  { id: "repos", label: "Repositories", icon: "FolderGit2" },
  { id: "general", label: "General", icon: "SlidersHorizontal" },
  { id: "access", label: "GitHub access", icon: "KeyRound" },
  { id: "advanced", label: "Advanced JSON", icon: "Braces" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function RepoEditor({ repo, index, problems, open, onToggle, onChange, onRemove, projects, providers, defaultProvider, workflows }: { repo: RepoConfig; index: number; problems: string[]; open: boolean; onToggle: () => void; onChange: (r: RepoConfig) => void; onRemove: () => void; projects: Project[]; providers: Provider[]; defaultProvider: string; workflows: WorkflowsDocument }) {
  const set = <K extends keyof RepoConfig>(key: K, value: RepoConfig[K]) => onChange({ ...repo, [key]: value });
  const project = projects.find((p) => p.id === repo.projectId);
  const title = repo.owner && repo.repo ? repoKey(repo) : `Repository ${index + 1}`;
  const placeholder = isPlaceholderRepo(repo);
  return (
    <article className={cn("rounded-lg border bg-background", problems.length ? "border-destructive/60" : "border-border")}>
      <header className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle} aria-expanded={open}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} fallback="Circle" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Icon name="Github" fallback="FolderGit2" className="size-4 shrink-0 text-foreground" aria-hidden />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {project ? `Project ${project.name}` : repo.projectId ? `Project ${repo.projectId}` : "No project selected"} · {repo.intake ? `issues labelled ${repo.issueFilter.labels.join(", ") || "(none)"}` : "intake paused"} · up to {repo.maxConcurrent} tasks
            </span>
          </span>
        </button>
        {placeholder ? <StatusPill tone="warning" label="Placeholder, ignored" /> : problems.length ? <StatusPill tone="critical" label={`${problems.length} to fix`} /> : null}
        <ConfirmRemove label={`Remove ${title}`} onConfirm={onRemove} />
      </header>
      {open ? (
        <div className="flex flex-col gap-5 border-t border-border px-3 py-4">
          <Problems items={problems} />
          <Group title="Source" icon="FolderGit2">
            <Field label="BB project" hint="The project whose checkout agents work in. Project ids are specific to this bb.">
              {(id) => <ProjectPicker id={id} value={repo.projectId} projects={projects} repo={repo} onChange={(v) => onChange(selectProject(repo, v, projects))} />}
            </Field>
            <Field label="GitHub repository" hint="Filled in from the project's GitHub remote. Change it only to target a different repository.">
              {(id) => <RepoSlugInput id={id} repo={repo} onChange={(owner, name) => onChange({ ...repo, owner, repo: name })} />}
            </Field>
          </Group>
          <Group title="Issue intake" icon="Inbox" cols={3}>
            <ToggleRow label="Pick up issues" hint="Off: only tasks you start." checked={repo.intake} onChange={(v) => set("intake", v)} />
            <Field label="Issue labels" hint="Issues must carry all of these. Comma separated.">{(id) => <ListInput id={id} value={repo.issueFilter.labels} onChange={(v) => set("issueFilter", { ...repo.issueFilter, labels: v })} placeholder="agent-ready" />}</Field>
            <Field label="Assignee" hint="Optional GitHub login.">{(id) => <TextInput id={id} value={repo.issueFilter.assignee ?? ""} onChange={(v) => set("issueFilter", { ...repo.issueFilter, assignee: v })} placeholder="any" />}</Field>
            <Field label="Max concurrent tasks">{(id) => <NumberInput id={id} value={repo.maxConcurrent} min={0} max={50} onChange={(v) => set("maxConcurrent", v)} />}</Field>
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
          <Group title="Workflow" icon="Workflow" cols={2}>
            <Field label="Workflow for this repository" hint="Edit workflows under Workflows. Tasks keep the workflow they started with.">
              {(id) => (
                <Select
                  id={id}
                  value={typeof repo.workflow === "string" ? repo.workflow : repo.workflow ? "__legacy" : ""}
                  onChange={(v) => set("workflow", v === "__legacy" ? repo.workflow : v || undefined)}
                  options={[
                    { value: "", label: `Default (${workflows.workflows.find((w) => w.id === workflows.default)?.name ?? workflows.default})` },
                    ...workflows.workflows.map((w) => ({ value: w.id, label: w.name })),
                    ...(repo.workflow && typeof repo.workflow !== "string" ? [{ value: "__legacy", label: "Converted from the old stage settings" }] : []),
                  ]}
                />
              )}
            </Field>
          </Group>
          <Group title="Pull requests" icon="GitPullRequest" cols={2}>
            <Field label="Reviewers" hint="GitHub logins asked to review Chief of Staff's PRs.">{(id) => <ListInput id={id} value={repo.reviewers} onChange={(v) => set("reviewers", v)} />}</Field>
            <Field label="Merge strategy" hint="Used when Ship merges.">
              {(id) => (
                <Select id={id} value={repo.mergeStrategy} onChange={(v) => set("mergeStrategy", v)} options={[{ value: "squash", label: "Squash" }, { value: "merge", label: "Merge commit" }, { value: "rebase", label: "Rebase" }]} />
              )}
            </Field>
          </Group>
        </div>
      ) : null}
    </article>
  );
}

// ---------- general + access ----------

function GeneralEditor({ values, onChange, providers }: { values: GeneralSettings; onChange: (v: GeneralSettings) => void; providers: Provider[] }) {
  const set = <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => onChange({ ...values, [key]: value });
  return (
    <div className="flex flex-col gap-5">
      <Group title="Capacity" icon="Gauge" cols={3}>
        <Field label="Max tasks across all repos">{(id) => <NumberInput id={id} value={values.maxConcurrentTotal} min={0} max={100} onChange={(v) => set("maxConcurrentTotal", v)} />}</Field>
        <Field label="Intake every (minutes)">{(id) => <NumberInput id={id} value={values.intakeIntervalMinutes} min={1} max={1440} onChange={(v) => set("intakeIntervalMinutes", v)} />}</Field>
        <Field label="Stalled after (minutes)" hint="No activity for this long marks an agent stalled.">{(id) => <NumberInput id={id} value={values.stallThresholdMinutes} min={1} max={1440} onChange={(v) => set("stallThresholdMinutes", v)} />}</Field>
      </Group>
      <Group title="Default agent" icon="Bot" cols={2}>
        <Field label="Provider">{(id) => <ProviderPicker id={id} value={values.defaultProviderId} providers={providers} allowDefault="bb default" onChange={(v) => set("defaultProviderId", v)} />}</Field>
        <Field label="Model" hint="Empty uses the provider's default.">{(id) => <TextInput id={id} value={values.defaultModel} onChange={(v) => set("defaultModel", v)} placeholder="default" />}</Field>
      </Group>
      <Group title="Notifications" icon="Bell" cols={1}>
        <ToggleRow label="BB push notifications" hint="Questions, plans to approve, escalations and shipped work. Uses the push-notifications plugin when installed." checked={values.notifyPush} onChange={(v) => set("notifyPush", v)} />
      </Group>
      <Group title="Housekeeping" icon="Archive" cols={1}>
        <ToggleRow label="Archive threads when a task is done" hint="Once a task's workflow finishes, its builder and step threads are archived. Failed tasks keep theirs so you can look into them." checked={values.archiveThreadsOnDone} onChange={(v) => set("archiveThreadsOnDone", v)} />
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

function AdvancedEditor({ repos, workflow, locked, onSaved }: { repos: string; workflow: string; locked: boolean; onSaved: () => Promise<void> }) {
  const rpc = useRpc<Contract>();
  const [r, setR] = useState<string | null>(null);
  const [t, setT] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    setStatus(null);
    try {
      const result = await rpc.call("cos_set_config", { ...(r !== null ? { repos: r } : {}), ...(t !== null ? { workflow: t } : {}) });
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
        <Field label="Workflow">{(id) => <textarea id={id} disabled={locked} className="min-h-72 w-full rounded-md border border-input bg-transparent p-2 font-mono text-xs text-foreground disabled:opacity-50" value={t ?? workflow} onChange={(e) => setT(e.target.value)} spellCheck={false} />}</Field>
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

export function Configurator({ initialSection = "workflow", compact = false }: { initialSection?: Section; compact?: boolean }) {
  const rpc = useRpc<Contract>();
  const config = experimental_useRpcQuery<Contract, "cos_get_config">({ contract: rpcContract, method: "cos_get_config", input: null });
  const settings = experimental_useRpcQuery<Contract, "cos_get_settings">({ contract: rpcContract, method: "cos_get_settings", input: null });
  const [section, setSection] = useState<Section>(initialSection);
  const [repos, setRepos] = useState<RepoConfig[] | null>(null);
  const [general, setGeneral] = useState<GeneralSettings | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowsDocument | null>(null);
  const [openRepo, setOpenRepo] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const loadedRepos = useMemo(() => (config.data ? loadRepos(config.data.repos) : null), [config.data]);
  const loadedGeneral = settings.data?.values ?? null;
  const loadedWorkflow = useMemo(() => (config.data ? parseWorkflows(config.data.workflow) : null), [config.data]);
  const workflowDraft: WorkflowsDocument = workflow ?? (loadedWorkflow?.ok ? loadedWorkflow.value : DEFAULT_DOCUMENT);

  const projects = useMemo(() => settings.data?.projects ?? [], [settings.data]);
  // Entries saved without owner/repo show the repository inferred from their project.
  const repoDraft = useMemo(() => repos ?? (loadedRepos?.ok ? loadedRepos.items.map((r) => inferIdentity(r, projects)) : []), [repos, loadedRepos, projects]);
  const generalDraft = general ?? loadedGeneral;
  const generalChanges = loadedGeneral && general ? generalDiff(loadedGeneral, general) : {};
  const dirty = { repos: repos !== null, general: Object.keys(generalChanges).length > 0, workflow: workflow !== null };
  const anyDirty = dirty.repos || dirty.general || dirty.workflow;

  const repoIssues = useMemo(() => validateRepos(repoDraft), [repoDraft]);
  const workflowProblems = useMemo(() => validateDocument(workflowDraft), [workflowDraft]);
  /** Every blocking problem, with where it is, so the save bar can point at it. */
  const problems = useMemo(() => {
    const out: { section: Section; repo?: number; text: string }[] = [];
    for (const [i, list] of Object.entries(repoIssues)) {
      const r = repoDraft[Number(i)];
      const name = r && r.owner && r.repo ? repoKey(r) : `Repository ${Number(i) + 1}`;
      for (const text of list) out.push({ section: "repos", repo: Number(i), text: `${name}: ${text}` });
    }
    for (const text of workflowProblems) out.push({ section: "workflow", text });
    return out;
  }, [repoIssues, repoDraft, workflowProblems]);
  const problemCount = problems.length;
  const sectionProblems = (id: Section) => problems.filter((p) => p.section === id).length;
  const usedBy = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const r of repoDraft) {
      const id = typeof r.workflow === "string" ? r.workflow : r.workflow ? null : workflowDraft.default;
      if (id) (out[id] ??= []).push(repoKey(r) || r.projectId);
    }
    return out;
  }, [repoDraft, workflowDraft]);

  const refetchAll = async () => {
    await Promise.all([config.refetch(), settings.refetch()]);
  };
  useRealtime("cos-changed", () => {
    if (!anyDirty) void refetchAll();
  });

  const discard = () => {
    setRepos(null);
    setGeneral(null);
    setWorkflow(null);
    setStatus(null);
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const warnings: string[] = [];
      if (dirty.repos || dirty.workflow) {
        const result = await rpc.call("cos_set_config", {
          ...(dirty.repos ? { repos: serializeRepos(repoDraft) } : {}),
          ...(dirty.workflow ? { workflow: serializeWorkflows(workflowDraft) } : {}),
        });
        warnings.push(...result.warnings);
      }
      if (dirty.general) await rpc.call("cos_set_settings", generalChanges);
      await refetchAll();
      setRepos(null);
      setGeneral(null);
      setWorkflow(null);
      setStatus({ ok: true, text: warnings.length ? `Saved. ${warnings.join("; ")}` : "Saved. Changes apply on the next intake and sweep." });
    } catch (error) {
      setStatus({ ok: false, text: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const providers = settings.data?.providers ?? [];
  const counts: Record<Section, number | null> = { workflow: null, repos: repoDraft.length, general: null, access: null, advanced: null };
  const sectionDirty: Record<Section, boolean> = { workflow: dirty.workflow, repos: dirty.repos, general: dirty.general, access: false, advanced: false };
  const loadError =
    (loadedRepos && !loadedRepos.ok ? `Repositories JSON: ${loadedRepos.error}` : null) ??
    (loadedWorkflow && !loadedWorkflow.ok ? `Workflow JSON: ${loadedWorkflow.error}` : null);

  if (config.error || settings.error) return <Problems items={[errorText(config.error ?? settings.error)]} />;
  if (!config.data || !settings.data || !generalDraft) return <p className="text-sm text-muted-foreground">Loading configuration…</p>;

  return (
    <div className={cn("flex flex-col gap-4", compact ? "" : "lg:flex-row lg:items-start")}>
      <nav className={cn("flex flex-wrap gap-1", compact ? "flex-row" : "flex-row lg:w-52 lg:shrink-0 lg:flex-col lg:flex-nowrap")} aria-label="Configuration sections">
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
            {sectionProblems(s.id) ? (
              <span aria-label={`${sectionProblems(s.id)} to fix`} className="rounded-full px-1.5 text-[11px] font-semibold text-white tabular-nums" style={{ background: STATUS.critical }}>
                {sectionProblems(s.id)}
              </span>
            ) : sectionDirty[s.id] ? (
              <span aria-label="unsaved" className="size-1.5 rounded-full" style={{ background: STATUS.warning }} />
            ) : null}
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {loadError && section !== "advanced" ? (
          <Problems items={[`${loadError}. Fix it in Advanced JSON; the visual editor shows the last valid parts only.`]} />
        ) : null}
        {section === "workflow" ? <WorkflowsEditor doc={workflowDraft} onChange={setWorkflow} usedBy={usedBy} /> : null}
        {section === "repos" ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">Each repository has its own issue filter, agent and limits, and can customise any workflow stage.</p>
              <Button
                size="sm"
                onClick={() => {
                  setRepos([...repoDraft, inferIdentity(blankRepo(projects.length === 1 ? projects[0]!.id : ""), projects)]);
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
                  workflows={workflowDraft}
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
        {section === "general" ? <GeneralEditor values={generalDraft} onChange={setGeneral} providers={providers} /> : null}
        {section === "access" ? <AccessEditor token={settings.data.token} onSaved={refetchAll} /> : null}
        {section === "advanced" ? <AdvancedEditor repos={config.data.repos} workflow={config.data.workflow} locked={anyDirty} onSaved={refetchAll} /> : null}

        {anyDirty || status ? (
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-sm">
            {anyDirty ? (
              <>
                <span className="flex items-center gap-1.5 text-sm text-foreground">
                  <span aria-hidden className="size-2 rounded-full" style={{ background: STATUS.warning }} />
                  Unsaved changes
                  {problemCount ? <span className="text-xs" style={{ color: STATUS.critical }}>· {problemCount} to fix before saving</span> : null}
                </span>
                <span className="ml-auto flex gap-1.5">
                  <Button size="sm" variant="outline" disabled={saving} onClick={discard}>
                    Discard
                  </Button>
                  <Button size="sm" disabled={saving || problemCount > 0} onClick={() => void save()}>
                    <Icon name="Save" fallback="Circle" aria-hidden /> {saving ? "Saving…" : "Save changes"}
                  </Button>
                </span>
                {problemCount ? (
                  <ul className="flex basis-full flex-col gap-0.5">
                    {problems.slice(0, 5).map((p, i) => (
                      <li key={i}>
                        <button
                          type="button"
                          className="flex items-start gap-1.5 text-left text-xs hover:underline"
                          style={{ color: STATUS.critical }}
                          onClick={() => {
                            setSection(p.section);
                            if (p.repo !== undefined) setOpenRepo(p.repo);
                          }}
                        >
                          <Icon name="CircleAlert" fallback="Circle" className="mt-0.5 size-3 shrink-0" aria-hidden />
                          <span>
                            <b>{SECTIONS.find((x) => x.id === p.section)?.label}</b> · {p.text}
                          </span>
                        </button>
                      </li>
                    ))}
                    {problemCount > 5 ? <li className="text-xs text-muted-foreground">and {problemCount - 5} more</li> : null}
                  </ul>
                ) : null}
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
