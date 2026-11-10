# Contributing

## Setup

```sh
npm ci
npm run lint       # ESLint, no warnings allowed
npm run check      # lint + typecheck + tests, same as CI
npm run build      # needs the bb CLI (bb plugin build); without it:
                   # npx --package=bb-app@0.49.0 bb plugin build
```

Node 22 (see `.nvmrc`).

## Pull requests

- Branch from `main`; one PR per feature or fix, with its tests and docs.
- Title follows [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat: ...`, `fix: ...`, `docs: ...`, `ci: ...`). CI enforces this.
- Add an entry under `## Unreleased` in `CHANGELOG.md` describing the
  user-visible effect. For changes with none (CI, tests, internal docs), apply
  the `skip-changelog` label.
- CI must be green: lint, typecheck, tests and the plugin build.
- Database migrations are append-only. Never reorder or edit a shipped one;
  existing installs validate their recorded hashes.

## Releasing

1. In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z` and add a fresh
   empty `## Unreleased` above it.
2. Bump `version` in `package.json` and `package-lock.json`
   (`npm version X.Y.Z --no-git-tag-version`), and the pinned example in
   `README.md`.
3. Merge that as a PR titled `chore: release vX.Y.Z`.
4. Tag the merge commit and push the tag:
   `git tag vX.Y.Z && git push origin vX.Y.Z`.

The release workflow re-runs lint, typecheck, tests and the plugin build,
verifies the tag, the `package.json` version and the changelog section agree
(`scripts/release-notes.mjs`), and publishes a GitHub release using that
changelog section as notes. Versions follow semver.
