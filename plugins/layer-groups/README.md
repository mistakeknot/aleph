# Layer groups

Provisions sidebar sections from a pace-layer registry JSON file. The plugin is
disabled by default. Enable it with `bb plugin enable bb--layer-groups` or in
Settings → Installed plugins → Layer groups.

`mode` defaults to `preview` and accepts `preview` or `apply`. `registryPath`
defaults to an empty string, which leaves provisioning unconfigured. Set both
through the plugin settings or the CLI:

```bash
bb plugin config bb--layer-groups set registryPath /path/to/registry.json
bb plugin config bb--layer-groups set mode preview
bb layer-groups provision
bb plugin config bb--layer-groups set mode apply
bb layer-groups provision
```

Inspect the preview before switching to apply. Apply creates missing sections;
it preserves existing owned section IDs and their current labels. Deleting an
owned section disables that layer until explicitly reenabled. An existing
unowned section with the expected name blocks all creates until adopted or
renamed. Adoption requires the section to remain empty, including hidden and
archived threads, and retain its expected name during verification.

Commands return JSON. Each command is also available through
`bb plugin run bb--layer-groups <command>`:

- `bb layer-groups status` shows the registry read kind, commit, SHA-256, snapshot
  age in milliseconds and last run report.
- `bb layer-groups provision` previews or applies one run using the current mode.
- `bb layer-groups adopt B` explicitly adopts an empty matching section. A conflict
  returns a nonzero exit code and its reason.
- `bb layer-groups enable-layer D` reenables a deleted layer; the next apply run
  creates its section. `GSV` selects Studio for both enable-layer and adopt.
- `bb layer-groups export /path/to/export.json` writes `layerSections`,
  `assignments`, `overrides`, `snapshot` and `runs` as JSON. The path must be
  absolute; relative paths are rejected.

The `provision` schedule runs every 15 minutes. Overlapping provisions share one
run; adoption and recovery wait in the same queue. If the registry cannot be
read, apply creates nothing and records the error. Preview can show a stored
snapshot with an error. With no stored snapshot, neither mode provisions.

The plugin RPC `listOwnedSections` takes `{}` and returns `{ stale, sections }`.
Call it through the SDK's `plugins.callRpc` or the plugin RPC CLI. It lists only
active ownership rows whose sections still exist, in snapshot order. Each row
includes `sectionId`, `layer`, `letter`, canonical `layerName`, current
`sectionName`, `accent`, nullable `rank` and `order`. `stale` marks a failed registry
read when a stored snapshot remains available. This surface provisions sections;
it does not move threads or change sidebar preferences.
