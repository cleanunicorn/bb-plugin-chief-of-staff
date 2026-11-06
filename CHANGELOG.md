# Changelog

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
