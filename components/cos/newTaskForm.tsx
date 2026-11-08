import { useState } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";

const fieldClass = "w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

/** Hand Chief of Staff a task that has no GitHub issue; it runs the repo's workflow. */
export function NewTaskForm({ repos, onCancel, onStarted, startTask }: { repos: string[]; onCancel: () => void; onStarted: () => void | Promise<void>; startTask: (input: { repo: string; title: string; body: string }) => Promise<unknown> }) {
  const [selectedRepo, setRepo] = useState("");
  const repo = repos.includes(selectedRepo) ? selectedRepo : (repos[0] ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setSending(true);
    setError(null);
    try {
      await startTask({ repo, title: title.trim(), body: body.trim() });
      await onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };
  if (!repos.length) return <p className="mb-3 text-sm text-muted-foreground">Configure a repository first in the Configure tab. A GitHub issue and automatic intake are not required.</p>;
  return (
    <form
      className="mb-4 flex flex-col gap-2 rounded-lg border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && repo) void start();
      }}
    >
      <p className="text-sm text-muted-foreground">Choose a configured repository and describe the work. No GitHub issue or automatic intake is required; the task runs the repository's configured workflow and uses its capacity.</p>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_1fr]">
        <label className="text-xs font-medium text-muted-foreground">
          Repository
          <select className={cn(fieldClass, "mt-1")} value={repo} disabled={sending} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          Title
          <input className={cn(fieldClass, "mt-1")} value={title} disabled={sending} placeholder="Add rate limiting to /login" onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <label className="text-xs font-medium text-muted-foreground">
        What needs doing
        <textarea className={cn(fieldClass, "mt-1 min-h-24")} value={body} disabled={sending} placeholder="Context, acceptance criteria, constraints. The agent starts from this instead of an issue." onChange={(e) => setBody(e.target.value)} />
      </label>
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={sending || !title.trim() || !repo}>
          <Icon name="Play" fallback="Circle" aria-hidden /> {sending ? "Starting…" : "Start"}
        </Button>
      </div>
    </form>
  );
}

