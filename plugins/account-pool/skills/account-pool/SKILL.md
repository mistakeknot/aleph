---
name: account-pool
description: "Configure or diagnose Account Pooler accounts, authentication, quota routing, and failover through bb pool."
---

# Account Pooler

Use `bb pool` for this plugin's accounts and routes. Inspect current state with
`bb pool status --json` and `bb pool account list --json` before changing routing.
Use `bb pool --help` for available commands.

Use `bb pool exec -- codex ...` or `bb pool exec -- claude ...` when a process
outside a bb thread must use the current pool on the server's primary enrolled
host. The command exits with the child status. A successful child start adds a
`bb-pool-exec: transport=pooled provider=<provider>` stderr marker; an
unavailable pool or host runner fails without that marker.
Use `--stdin-file <absolute-path>` before `--` when the child reads a prompt
from stdin; the file is read on the enrolled host and is limited to 8 MiB.

For account login/import, secret handling, quota refresh, routing settings,
ordering, or failover, read
[references/accounts-and-routing.md](references/accounts-and-routing.md).

Use stdin or supported login/import flows for credentials; never put secret values
in command arguments or chat. Confirm the resulting account and routing state.
Do not enable the plugin or change accounts unless the requested task calls for it.
