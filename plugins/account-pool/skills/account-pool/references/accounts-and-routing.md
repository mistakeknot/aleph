The builtin Account Pooler plugin is disabled by default. Enable it, add Claude
or Codex credentials, and inspect its proxy routes and account quota with:

```sh
bb plugin enable account-pool
bb pool account add --provider claude --login
printf '%s\n' "$CLAUDE_AUTH_CODE" | bb pool account login-complete --session <id> --code-stdin
bb pool account add --provider codex --login
bb pool account login-poll --session <id>
bb pool account add --provider claude --import
bb pool account add --provider codex --import
printf '%s\n' "$ANTHROPIC_API_KEY" | bb pool account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]
bb pool account add --provider claude --api-key <key> [--label <text>] [--priority <n>]
bb pool account list [--json]
bb pool account remove <id>
bb pool account enable <id>
bb pool account disable <id>
bb pool account priority <id> <n>
bb pool account reorder <claude|codex> <id>...
bb pool account refresh <id>
bb pool status [--json]
bb pool routing <claude|codex> [--off]
bb pool config
bb pool config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold|parentMode> <value>
bb pool parent [proxy|isolate]
bb pool token rotate --machine <id-or-name>
bb pool bypass <thread-id> [--off]
bb pool exec [--stdin-file <absolute-path>] -- codex exec <codex-options> <prompt>
bb pool exec -- claude --print <claude-options> <prompt>
```

Every command accepts `--json` and `--help`. `bb pool --help` lists the
commands; `bb pool <command> --help` prints that command's arguments, options,
and rules, including which flags cannot be combined. Unknown commands, unknown
flags, and stray arguments are rejected with the nearest suggestion rather than
ignored, and a failing invocation that carries `--json` also prints
`{"ok":false,"error":{"code","message","hint"}}` on stdout.

Claude `--login` starts a PKCE session, prints a browser URL and session ID,
then exits. Pipe the manual callback code to `account login-complete` with that
session ID within ten minutes. Codex `--login` prints a device verification
URL, one-time code, session ID, and an `account login-poll` command that waits
for authorization. The Claude code stays out of process arguments, and either
browser may be on a different machine from the bb server. Newly added or
enabled accounts are available without a plugin reload. With an
enabled account whose secret file remains readable and valid, matching Claude
Code or Codex sessions receive the pool route and a distinct secret token for
their machine.
Codex receives `CODEX_OPENAI_BASE_URL` and the secret
`CODEX_POOL_AUTH_TOKEN`; bb applies them as in-memory app-server config.
Codex image generation and editing use the same authenticated pool route.
Tokens are never printed. `status` prunes tokens for unenrolled machines and
shows token timestamps plus recently routed threads whose machines need a
local Claude login before the pool can be disabled safely. Rotation keeps the
prior token valid for ten minutes. Agents should pipe API keys to
`--api-key-stdin`;
`--api-key <key>` is an unsafe compatibility form that exposes the key in
process arguments, shell history, and agent transcripts. Prefer `--import` for
an existing Claude Code login. The CLI Codex import path reads
`~/.codex/auth.json` on the bb server host. OAuth quota refreshes on add or
enable and every five minutes while an account is idle. When a request finds no
eligible account, the pool first refreshes the OAuth accounts it considers
exhausted, at most once every 30 seconds per account, so a plan upgrade or an
early reset takes effect on the next turn. Use
`bb pool account refresh <id>` to request an immediate refresh for one account.
Account tables add columns for observed model-family buckets; JSON status
exposes their utilization, reset, status, observation time, and source under
`familyWeekly`. Selection skips an account whose requested family is spent
while retaining it for other families. A present `metadata.user_id` account
UUID is aligned with the selected OAuth account. Use `bb pool config` to
inspect the full routing configuration and
`bb pool config set <key> <value>` to update one value. The upstream URL keys
are QA-only overrides; `switchThreshold` must be greater than 0 and at most 1.
`BB_ACCOUNT_POOL_EXEC_INPUT_DIR` is operator-owned server-startup configuration for
stdin files, not a CLI or settings RPC key. When unset, the host resolves the
fixed default `<daemon HOME>/.local/state/bb-account-pool/exec-input` from its
own environment at plugin load. The default needs no server environment change
or process restart; caller cwd, `TMPDIR`, and `XDG_STATE_HOME` do not affect it.
Legacy `execInputDir` KV values are discarded, not trusted or migrated.

`bb pool exec` is the non-thread entry point for scheduled or supervised
processes running on the bb server's primary enrolled host. It accepts only the
bare provider name `codex` or `claude` after `--`; paths and alternate
executables are rejected, and the host daemon resolves that name from its own
`PATH`. It fetches the current machine token at
invocation time, and sends it to the host daemon over authenticated host RPC.
The daemon puts the credential only in the child environment, redacts an exact
token if the child echoes it, and never stores or prints it. Codex's non-secret
custom-provider settings are passed as `-c` options because Codex does not read
its custom provider base URL from an environment variable; the bearer remains
environment-only. The command preserves stdout, stderr, and the child's exit
code. All caller `-c` and `--config` spellings, profiles, provider selectors,
and unknown options are rejected at both CLI and host boundaries. Accepted
arguments are normalized and the prompt is placed after `--` so it cannot
select a nested subcommand. Codex's host-owned provider settings are inside
`exec`, with `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, approval
policy `never`, and workspace tool-network access disabled. The default
sandbox is read-only.

Codex callers may supply `--model`, `--sandbox` (read-only or workspace-write),
`--cd`, `--output-schema`, `--output-last-message`, `--color` (auto, always, never),
`--json`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and one prompt
or `-` for stdin. Value options accept separate or `--key=value` forms. Claude
must start with `--print` or `-p`; it accepts `--model`, `--output-format` (text
or json), `--max-turns`, and one prompt. Other short options are not accepted.

Claude receives `--setting-sources user` after argument validation. Both caller
`--setting-sources` spellings and `--settings` are rejected: project and local
settings cannot replace the endpoint, run their hooks/helpers, or select another
provider. The host also sets `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` to prevent
settings-file provider/auth/endpoint variables from overriding its route, and
sets inherited Bedrock, Vertex and Foundry selectors to `0`.

`CLAUDE_CONFIG_DIR` is resolved to an absolute path at host-entry creation from
the daemon's own environment, defaulting to its `HOME/.claude`. Relative values
are anchored at the daemon cwd, never the caller cwd. Caller environments are
not forwarded. This preserves the daemon operator's user permissions and
customizations; it is not a fresh profile. The directory, its symlink targets,
and user hooks/helpers/plugins must be controlled by trusted daemon operators,
the same trust boundary as the daemon's environment and executable `PATH`.
The routing guard is not containment of malicious operator-owned code. Managed
administrative policy still applies. A/B probes cover project, local and user
endpoint redirects on Claude Code 2.1.280; rerun them for provider upgrades.
See the official [CLI reference](https://code.claude.com/docs/en/cli-reference)
and [environment reference](https://code.claude.com/docs/en/env-vars).

A confirmed, provider-pinned start emits `transport=pooled`. A pre-dispatch
host check is the only host-offline case reported without a start marker. If
RPC fails after dispatch, the command reports lost contact and emits
`transport=pool-unconfirmed`: the child may have started and must not be replayed.
The internal `providerPinned` field means a child started with this host-owned
routing construction (it equals `started` on host responses), not an attestation
of an upstream response. An indeterminate RPC result cannot establish it.
For a child that expects stdin, `--stdin-file` names an absolute file on the
enrolled host. Use the default directory above, or an operator's server-startup
override. The host creates a missing directory with mode `0700`, then verifies
the opened directory belongs to its effective user and has exactly mode `0700`.
It rejects incorrect ownership or permissions without repairing them.
The host refuses root, its home, and
ancestors of either its configured `CODEX_HOME` or default `~/.codex`, as well
as those credential directories and their descendants. Validation resolves
aliases even when the protected directory does not yet exist. Files must be
direct children of the configured directory. On Linux the daemon opens a
checked directory descriptor and opens the file through `/proc/self/fd` with
`O_NOFOLLOW`, checks `fstat` for a regular file, and reads at most 8 MiB. This
does not follow a replaced leaf or directory path. Other platforms fail closed.
The caller remains responsible for private file permissions and deletion.

Accounts run sequentially per provider: lower priority numbers first, with ties
following the order accounts were added. New conversations use the current
account until it reaches the switch threshold or fails; the pool then advances
to the next eligible account and wraps at the end. It keeps using that fallback
even when an earlier account recovers. Existing conversations stay pinned while
their account remains eligible. Short temporary rate limits wait on the same
account once; longer holds return Retry-After for pinned conversations while new
conversations can advance. A model-family limit detours only requests for that
family without moving the session's main pin or the provider cursor. The cursor
and session pins survive hub restarts. Session pins expire after 30 idle minutes,
and the pool retains the 4,096 most recently used pins.

Drag an account’s handle in Account Pooler settings (or focus the handle and use
Space, arrow keys, and Space again), or
`bb pool account reorder <claude|codex> <id>...`, to set the complete order for
one provider. Include disabled accounts too. Reordering changes the next failover
sequence without moving the current account. `bb pool account priority <id> <n>`
sets an individual priority; the same operations are available through the
`account.reorder` and `account.setPriority` plugin RPCs.

## Thread-bound eligibility

`GET /api/v1/plugins/account-pool/http/availability?threadId=<id>` accepts the
calling process's existing machine token in `x-bb-account-pool-token` (or the
hub's existing Bearer authorization header). Never print or copy that token into
command arguments. A successful response is:

```json
{"threadId":"thr_example","availability":{"claude":true,"codex":false}}
```

The thread's current environment must belong to the authenticated machine,
which must still be enrolled. A missing environment, deleted thread, destroyed
environment or ownership mismatch cannot authorize borrowing. Missing/invalid
tokens return 401; invalid or repeated thread IDs return 400; ownership refusals
return 403; failed ownership lookups return 503. The server normally hides a
soft-deleted thread behind an SDK 404, which therefore returns 503 here; an
exposed deleted row is refused with 403. Both paths fail closed. Responses are
not cached.
Callers must treat errors as unknown eligibility, not as a fallback to unrelated
credentials. Thread IDs contain only ASCII letters, digits, underscores and
hyphens, with a maximum length of 200 characters.

The booleans use the same decision as provider environment contribution: thread
bypass, provider routing switches, readable enabled local accounts, and parent
availability in proxy mode. Isolate mode never uses parent availability but may
use this instance's local pool accounts. Parent availability retains its existing
30-second cache. This is a routing decision, not a reservation or proof of model
quota, account selection, usage, or a completed provider request.

The check returns neither a bearer nor provider environment variables, does not
mark the thread as routed, and does not synthesize cross-provider native aliases.
It is bound to a thread owned by the machine bearer, not a new thread-scoped
credential: holders of that bearer may query other threads on the same machine.
Provider traffic continues to use the existing machine-token authorization.
Without `threadId`, the endpoint retains its provider-wide `{claude,codex}` shape
for nested servers and legacy clients; that response does not establish
cross-provider eligibility for a particular thread.

## Nested bb servers

A bb server started from inside another bb server's thread inherits that parent's
pooler routing through its environment. The parent contributes
`BB_ACCOUNT_POOL_PARENT_URL` and `BB_ACCOUNT_POOL_PARENT_TOKEN` alongside the
provider routing variables, and the nested server enables the pooler on first run
when it sees them.

`bb pool parent` reports the detected parent, the current mode, and which
providers the parent can serve. `bb pool parent proxy` and `bb pool parent
isolate` set the mode; `bb pool config` shows it as `parentMode`.

In `proxy` mode the nested server runs its own hub and mints its own machine
tokens, forwarding pooled traffic upstream with the parent's token, so the
parent's token is never handed to the nested server's agents. It reads the
parent's `/availability` endpoint and contributes routing only for providers the
parent can actually serve; if the parent is unreachable it contributes nothing
and neutralises the inherited values rather than pointing agents at a dead hub.

In `isolate` mode the nested server contributes empty routing variables, which
overrides the inherited values so threads fall back to that instance's own
accounts or to each provider's own credentials.

Proxied traffic authenticates as the parent machine's token, so `bb pool status`
on the parent attributes it to the parent host rather than to the nested
instance.
