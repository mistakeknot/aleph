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
host. Only allowlisted `codex exec` and `claude --print` options are accepted;
all caller Codex config/profile/provider overrides are rejected. The host pins
the pooled provider inside `exec`. The command exits with the child status.
Claude receives host-owned `--setting-sources user` and host-managed provider
routing. Caller settings-source overrides are rejected. Its config directory
is anchored to the daemon environment, not the caller cwd; the daemon's user
hooks/plugins remain trusted operator code. See the reference for this boundary.
A confirmed, provider-pinned child start adds a
`bb-pool-exec: transport=pooled provider=<provider>` stderr marker; an
unavailable pool or a host found offline before dispatch fails without that
marker. Lost contact after dispatch emits `transport=pool-unconfirmed` and
must not be retried.
Use `--stdin-file <absolute-path>` before `--` when the child reads a prompt
from stdin. An operator must first set `BB_ACCOUNT_POOL_EXEC_INPUT_DIR` in the
BB server's startup environment; the CLI and settings RPC cannot change it.
Files must be regular, non-symlink direct children of that directory on the
Linux enrolled host and are limited to 8 MiB. Root, home, Codex credential
directories and their ancestors are forbidden. See the reference for the
argument allowlist and descriptor-based file boundary.

For account login/import, secret handling, quota refresh, routing settings,
ordering, or failover, read
[references/accounts-and-routing.md](references/accounts-and-routing.md).

Use stdin or supported login/import flows for credentials; never put secret values
in command arguments or chat. Confirm the resulting account and routing state.
Do not enable the plugin or change accounts unless the requested task calls for it.
