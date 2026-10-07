Drop SCOUT-Setup-<version>.exe here and publish it from the panel's Operations tab.

`npm run package:windows` builds the installer (see installer/README.md). Publishing registers the
file with the release registry (recordings/ops/releases.json) and points every approved dashboard at
`/download/<file>`; the whole folder is gitignored, because an installer is build output, not source.
