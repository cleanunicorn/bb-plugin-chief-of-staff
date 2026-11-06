# Changelog

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
