---
name: layer-groups
description: "Preview and provision BB sidebar pace-layer sections from a registry JSON."
---

# Layer groups

Enable the plugin with `bb plugin enable bb--layer-groups`. Configure the
`registryPath` string (default empty, unconfigured) and `mode` select (default
`preview`, also accepts `apply`) under Installed plugins → Layer groups, or:

```bash
bb plugin config bb--layer-groups set registryPath /path/to/registry.json
bb plugin config bb--layer-groups set mode preview
bb layer-groups status
bb layer-groups provision
```

Read the provision report before applying. To create the sections:

```bash
bb plugin config bb--layer-groups set mode apply
bb layer-groups provision
```

`bb layer-groups status` reports snapshot kind, commit, SHA-256, age and the last
run report. `bb layer-groups provision` runs immediately; the schedule also runs
every 15 minutes. Concurrent provisions share a run, and adoption waits for it.

If a matching unowned section blocks provisioning, inspect it first.
`bb layer-groups adopt B` adopts the empty matching section for B. Hidden and
archived threads count as content. Conflicts return nonzero with a reason; a
populated section must be renamed or emptied before proceeding. Adoption is an
explicit ownership operation in either mode.

Deleting an owned section disables its layer. `bb layer-groups enable-layer D`
reenables D for creation on the next apply run. `GSV` selects Studio in both
adopt and enable-layer. `bb layer-groups export /path/to/export.json` writes all
five plugin data collections for inspection. The path must be absolute;
relative paths are rejected.

Apply makes no provision changes when the registry is unreadable. Preview may
show the stored snapshot with an error. Owned section renames are preserved.
`listOwnedSections` RPC accepts `{}` and exposes active, existing sections with
canonical layer names, current section labels, accents and snapshot ordering.
Use `bb plugin rpc` live help to invoke it. The commands also work through
`bb plugin run bb--layer-groups <command>`.
