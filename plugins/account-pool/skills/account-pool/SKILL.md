---
name: account-pool
description: "Configure or diagnose Account Pooler accounts, authentication, quota budgets, and routing through bb pool."
---

# Account Pooler

Use `bb pool` for this plugin's accounts and routes. Inspect current state with
`bb pool status --json` and `bb pool account list --json` before changing routing.
Use `bb pool burn --json` to see the share of the weekly pooled quota used in the last hour.
Use `bb pool --help` for available commands.

Use `bb pool exec -- codex ...` or `bb pool exec -- claude ...` when a tool
inside a bb thread must use the current pool on the server's primary enrolled
host. Only allowlisted `codex exec` and `claude --print` options are accepted;
all caller Codex config/profile/provider overrides are rejected. The host pins
the pooled provider inside `exec`. The command exits with the child status.
Claude receives `--setting-sources user` by default and host-managed provider
routing. Dispatch may select exactly `project,local`, replacing that default
without adding user settings.
Selecting `project,local` requires explicit `dontAsk` and a fixed allowed-tools
list. Every pooled Claude child receives `--strict-mcp-config` with no MCP
configuration, so project MCP servers do not load. Clavain dispatch does not
pass MCP configuration for review or execution seats.
The config directory is anchored to the daemon environment, not the caller cwd; the daemon's user
hooks/plugins remain trusted operator code. See the reference for this boundary.
Claude children inherit only PATH (executable lookup), HOME (runtime state),
LANG and LC_* (locale), TERM (terminal behavior), TMPDIR (temporary files),
USER (user identity), SHELL (tool shell), and the daemon-anchored
CLAUDE_CONFIG_DIR (operator settings). Other daemon variables, including
credentials and runtime injection variables, are excluded. The host adds
ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN for pooled routing,
CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1, CLAUDE_CODE_USE_BEDROCK=0,
CLAUDE_CODE_USE_VERTEX=0, CLAUDE_CODE_USE_FOUNDRY=0 (provider pinning),
ENABLE_TOOL_SEARCH=true (tool discovery), DISABLE_AUTOUPDATER=1 (keep the
verified executable from updating itself), and
CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 (credential isolation for tools).

Tool-capable launches require Linux, the verified Claude Code 2.1.323 release,
working socat and ripgrep executables, and a successful bubblewrap user/PID/network
namespace probe with nested user namespaces disabled. Unknown versions fail
closed until verified. The check runs before passing a pool token to Claude;
probe failures return a fixed error without subprocess output. This version's
scrub mode removes ANTHROPIC_AUTH_TOKEN from tool subprocesses and isolates
protected paths; merely omitting other daemon secrets does not protect this
token. Explicit --print --tools= launches remain available without the
preflight, but keep the scrub variable set (Claude can itself refuse startup
if bubblewrap is missing). Proxy, certificate, XDG and other tuning variables are deliberately excluded;
hosts that need those variables need a separately reviewed allowlist change.
The preflight checks dependencies and namespace primitives, not every possible
operator sandbox setting. Claude itself must refuse a tool when its scrub
sandbox cannot initialize. Rollout still requires a successful live tool canary.
No host permissions or sandbox policy are changed.

A confirmed, provider-pinned child start adds a
`bb-pool-exec: transport=pooled provider=<provider>` stderr marker; an
unavailable pool or a host found offline before dispatch fails without that
marker. Lost contact after dispatch emits `transport=pool-unconfirmed` and
must not be retried.
Use `--stdin-file <absolute-path>` before `--` when the child reads a prompt
from stdin. The default is `<daemon HOME>/.local/state/bb-account-pool/exec-input`,
resolved on the enrolled host, independent of caller cwd or private `/tmp`.
An operator can override it with `BB_ACCOUNT_POOL_EXEC_INPUT_DIR` in the BB
server's startup environment; the CLI and settings RPC cannot change it.
The host creates a missing directory as `0700` and verifies its owner and mode.
Files must be regular, non-symlink direct children of that directory on the
Linux enrolled host and are limited to 8 MiB. Root, home, Codex credential
directories, their ancestors and their descendants are forbidden. See the reference for the
argument allowlist and descriptor-based file boundary.

Exec requires a live calling thread on the primary host. Its absolute cwd must
exist there; missing thread provenance or a different host is refused.
The host also confines canonical cwd to the thread's recorded environment path
and refuses root, home, credential directories and their ancestors. Credential
roots include configured/default Codex and Claude directories and `.ssh`;
their descendants are refused too.
Raw piped stdin is not forwarded. Use `--prompt-file <absolute-path>` before `--` for a
regular, non-symlink prompt file directly in canonical caller cwd, at most 8 MiB.
Do not combine it with `--stdin-file`; prompt bytes become child stdin, never argv.
Use `--output-file <absolute-path>` to stream stdout into a new file directly in
canonical cwd, and stderr into its `.stderr` sibling. Both are exclusive-created
with mode 0600; existing files and symlinks are refused. Partial files remain on
failure. Token redaction holds incomplete token prefixes between chunks. Streamed
runs have no 900 KB limit; default buffered runs retain it. The child deadline is
`--timeout-seconds 1..3600`, default 3600; the CLI retains the child exit status.

Claude print mode can appear after other options. Dispatch accepts effort
`low|medium|high|xhigh|max`, permission mode `dontAsk`, allowed tools `Bash` or
`Bash,Edit,Write,NotebookEdit`, and disallowed tools
`Edit,Write,NotebookEdit,Agent,Task,Skill`, `Edit,Write,NotebookEdit`, or
`Agent,Task,Skill`. Output format is `text|json|stream-json`; `--verbose` requires
`stream-json`. One `--add-dir` may name a canonical existing directory within
canonical cwd, including cwd itself. Relative paths, traversal, symlink aliases,
outside directories and duplicate grants are refused. Plans outside cwd must be
copied into cwd first. Thread-storage roots are not exposed by this SDK path.
Permission bypass flags, `acceptEdits`, and free-form tool lists are refused.

For thread-bound eligibility before cross-provider dispatch, use the authenticated
`/availability?threadId=<id>` route described in the reference. A provider-wide
response without the matching thread ID is not proof of thread eligibility.
The endpoint returns no credentials and does not add native provider aliases.

For authenticated per-attempt account/model/usage evidence, use the plugin's
[receipt HTTP contract](references/receipts.md). Begin is a capability preflight;
do not start a budgeted CLI if it fails. Scoped tokens stay in child environment,
not command arguments, files or logs. Quota snapshots cannot prove usage.

For account sign-in and re-login, secret handling, quota refresh, routing settings,
ordering, or failover, read
[references/accounts-and-routing.md](references/accounts-and-routing.md).

Use stdin or the supported sign-in flows for credentials; never put secret values
in command arguments or chat. Confirm the resulting account and routing state.
Do not enable the plugin or change accounts unless the requested task calls for it.

Pooled rate-limit failures can be retried by Provider Retry using the pool’s
earliest usable account, even if the provider omits structured quota events.
Inspect `bb provider-retry explain <thread-id> --json` for the last decision
and `bb provider-retry status <thread-id> --json` for pending retries.
