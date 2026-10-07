# CI and release workflows

`ci.yml` and `release.yml` are the GitHub Actions workflows, kept here rather than in
`.github/workflows/` for one reason: the automation token that pushed the branch this came from
cannot create workflow files (GitHub refuses a push containing `.github/workflows/*` unless the
token carries the `workflows` permission). Everything in them is ordinary YAML, and installing
them is a copy:

```sh
mkdir -p .github/workflows
cp ci/*.yml .github/workflows/
git add .github/workflows && git commit -m "Add CI and release workflows" && git push
```

They can also be pasted straight into the GitHub web UI (Actions → New workflow), or added by any
push that has the `workflow` scope.

| File | What it does |
| --- | --- |
| `ci.yml` | Every push to `main` and every pull request: `tsc --noEmit`, `vite build`, `npm test`, and `cargo test` for `src-tauri/core` (geometry, plan, configuration, the licence parser). |
| `release.yml` | On a tag (`v0.4.1`) or by hand with a version: installs Rust + the Tauri CLI + Inno Setup, runs the shell tests, calls `node scripts/build-installer.mjs --version <v>` (the same command an operator runs, smoke test included), writes `SHA256SUMS.txt`, uploads the artifacts, and creates or updates the GitHub release the installer belongs to. |

`docs/RELEASE.md` describes what a release is, where the dashboard's download comes from, and what
still has to be checked on a real Windows machine. `ci.yml`'s ubuntu jobs are the same commands
`README.md`'s *Scope and verification* section lists as run in this checkout.
