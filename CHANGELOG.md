# Changelog

## Unreleased

- Repo entries infer `owner`/`repo` from the BB project's GitHub remote;
  `{ "projectId": "proj_..." }` is enough. Explicit values still override.
- Configurator: picking a BB project fills the GitHub repository from its
  remote, and a blank repository is accepted when the project has one.
- Fix: a check command that times out is killed with its whole process tree
  (`make`, test runners, docker clients) and reported as a failed check.
  Before, surviving children held the output pipe open and the run surfaced as
  "host plugin call exceeded its deadline".
- When Chief of Staff's own step fails (checks, opening the PR), the roster
  says so ("Chief of Staff could not run the repository checks (the agent is
  not asking anything): ...") instead of a bare "waiting on human".
- Better thread-state reading: an item parked as waiting on a human, with no
  open interaction and no plain-text question, is re-evaluated when its thread
  has moved on (a turn whose events were missed). On startup, including after
  a plugin update, items parked by Chief of Staff's own failure re-run their
  checks. The work-item database is kept across updates.

## 0.4.2

- The answer panel is larger by default (up to 64rem wide, 85% of the window
  tall) and resizable: drag the bottom-right corner (or focus it and use the
  arrow keys, Shift for bigger steps), double-click it to reset. The size is
  remembered. A maximize button in the header fills the window.

## 0.4.1

- The answer panel renders Markdown with BB's chat message renderer: the
  agent's last message, a plain-text question, question prompts, option
  descriptions, approval reasons and plans now look as they do in the thread.
  Commands and check output stay monospace. A trimmed last message is cut at a
  line break, and a code fence is reopened when the cut lands inside one.

## 0.4.0

- Answer agents from the dashboard. Click the question on a waiting card to
  open it: the agent's question with its options (and their descriptions), a
  free-text box when the question allows one, approval decisions with the
  command or plan being approved, and the context around it (the agent's last
  message, failing check output, last error). Send the answer, or open the
  thread instead.
- Answers go through `bb.sdk.threads.interactions.resolve` for questions,
  approvals and namespaced requests; plain-text questions get a reply message
  in the thread. Forms from other plugins link to the thread.
- New RPCs `cos_question` and `cos_answer`. Answers are validated against the
  open interaction (offered options, required questions, offered decisions),
  logged with who answered, and never logged verbatim.

## 0.3.0

- Thread state stays in sync with BB. Every minute the sweep re-reads each
  tracked thread and its pending interactions, so changes made directly in BB
  are picked up even when no event fires (or the plugin missed it).
- Resuming a thread works: when a waiting, blocked, failed or PR-open item's
  thread starts a new turn, the item goes back to running, and the next idle
  re-runs checks and pushes to the same branch. A human resume resets the fix
  budget.
- The plugin shows what the agent is asking. Questions, approval requests and
  plugin requests are stored on the item and shown on the dashboard card, in
  `bb cos status`, in the agent tool and in the notification.
- An agent that ends its turn with a plain-text question (no Summary section,
  last paragraph ends in "?") is marked waiting on human instead of being sent
  to checks.
- Unarchiving a thread that was archived mid-task resumes its item.

## 0.2.1

- Fix installing from GitHub: `@get-bb/plugin-sdk` and `@radix-ui/react-slot`
  are now runtime dependencies, so the production-only install that git
  sources use can build the frontend bundle.

## 0.2.0

- Visual configurator: Configure tab in the dashboard and on the plugin's
  settings page. Edit repositories, routines, general limits and GitHub access
  without touching JSON; validation before save; raw JSON still available.
- Multiple repositories, each with its own project, filters, agent and
  allow flags. New repos start least-privilege.
- Write-only GitHub token field; the token is never returned or logged.
- Incomplete repo entries load for editing instead of hiding the whole list.
- Install from GitHub with automatic updates documented.

## 0.1.0

- Initial release: agent roster with stall detection, GitHub issue intake into
  worktree agent threads, PR delivery with check command + CI fix cycles,
  routines (batch_merge, release, deploy, run_agent, notify) on a durable BB
  schedule, dashboard panel, `bb cos` CLI and `chief_of_staff_status` tool.
