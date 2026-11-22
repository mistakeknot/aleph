---
name: rig-manager
description: Inspect, diff, export and apply rigs through the Aleph rig manager plugin.
---

This wrapper runs on Aleph only for now. Stock packaging is not built yet.
All paths refer to the server host, including when the CLI runs remotely.

Set the rig path, target data directory and provider home in the plugin's
settings. The read-only panel shows entry identities and unsupported warnings
from Diff. It never displays omitted configuration values. Source root and
builtin root are optional explicit context paths.

Use **Rig: Export** and **Rig: Apply** in the command palette. Each command
opens its own form. Export requires a new absolute output path. Apply requires
a separate fresh, stopped target, a dry run, then explicit confirmation.

The CLI exposes the same adapter. All required paths are absolute:

```sh
bb rig diff --file /bundle/rig.yaml --target /fresh-install --agent-home /fresh-install/rig-home
bb rig export --file /bundle/rig.yaml --target /source-install --agent-home /provider-home --output /bundle/new-rig.yaml
bb rig apply --file /bundle/rig.yaml --target /fresh-install --agent-home /fresh-install/rig-home --dry-run
bb rig apply --file /bundle/rig.yaml --target /fresh-install --agent-home /fresh-install/rig-home --confirm TOKEN_FROM_DRY_RUN
```

Optional `--source-root` and `--builtin-root` select source and target builtin
directories. Results are JSON. Diff exits 1 for drift or unsupported entries.
Apply's confirmation token expires after five minutes, is single-use and is
invalid after server restart. Changes to the rig, context or dry-run result
require a new dry run. Apply rechecks the library's target boundary.

No live target, target with threads or escaped provider home is accepted.
Unknown scalar settings are omitted with opaque warnings. Named `env:` and
`store:` references never resolve here and stay inactive. Unsupported native
configuration can skip every write even if apply returns successfully. Review
the unsupported list; process exit alone does not prove activation.

Sources and hook programs remain trusted code. Review before confirming.
Database changes are transactional; files are not, and there is no rollback
command. An export is not a share-safe artifact. Provision credentials through
native secure mechanisms separately; this wrapper never resolves references.
