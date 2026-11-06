# Changelog

## Unreleased

- Repo entries infer `owner`/`repo` from the BB project's GitHub remote;
  `{ "projectId": "proj_..." }` is enough. Explicit values still override.
- Settings section: "Add a BB project" picker for projects with a GitHub remote.

## 0.1.0

- Initial release: agent roster with stall detection, GitHub issue intake into
  worktree agent threads, PR delivery with check command + CI fix cycles,
  routines (batch_merge, release, deploy, run_agent, notify) on a durable BB
  schedule, dashboard panel, `bb cos` CLI and `chief_of_staff_status` tool.
