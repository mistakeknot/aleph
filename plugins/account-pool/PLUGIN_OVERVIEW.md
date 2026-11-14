Budget Claude Code and Codex accounts with a local hub, priorities and quota thresholds.

## What you get

- Add accounts by browser/device sign-in or Anthropic API key. Each keeps a login; **Sign in again** renews it in place.
- Accounts run in priority order, ties by addition order. New conversations stay on the current fallback after earlier accounts recover. Existing conversations keep their account until refused.
- Reorder accounts in settings (Space: pick up/drop; arrows: move; Escape: cancel), or `bb pool account reorder <claude|codex> <id>...`.
- Account/model limits in settings and `bb pool status`.
- A routing switch per provider and a bypass per thread, so one thread can go straight to its own credentials.
- Header burn: pooled weekly-window share used in the last hour per provider, including outside-pool OAuth usage. Shows `—` until two readings; hover for five-hour equivalent and account shares.

## How it works

BB's hub serves Anthropic Messages and OpenAI Responses. Routed providers receive its URL and a machine-scoped token and report **Proxied**. Errored accounts are skipped. Accounts below the switch threshold (default 98%) go first; others serve until refused and are rechecked before fallback. Claude extra usage and Codex credits come last, and conversations return when quota recovers. Codex spending-control and credit-depletion restrictions block routing even below the threshold. The pool never enables extra usage, buys credits or changes spending limits. "Extra usage available" requires reported allowance. Secrets remain server-side and refresh automatically.

Short rate limits wait once on the same account. Longer holds return Retry-After for pinned conversations; new ones advance. Pins survive restarts and expire after 30 idle minutes.

Upstream HTTP/1.1 honors proxy environment variables; connection failures log error codes only.

## Nested bb servers

On Linux and macOS, a shell wrapper removes the pool URL, token and managed-provider flag from pooled Claude's shell tool subprocesses; the parent stays pooled. Nested Claude from those tools uses the machine's own Claude login, which must be available, outside pool accounting. Existing wrappers run after routing removal; otherwise Bash or zsh is resolved using Claude's shell overrides and search order. Claude's shell prefix also covers shell-form hooks and stdio MCP startup. PowerShell and exec-form hooks, LSP servers and plugin monitors may retain routing. Windows routing is unchanged. Scoped pooled child credentials are tracked in mk-gzfpf.1.

A bb server in an opted-in parent thread detects its pooler and enables this plugin. Opt in with `bb pool config set nestedLaunchThreadIds '["thr_example"]'`; `'[]'` (default) opts all out. Select mode in settings or `bb pool parent`:

- **proxy** (default): a local hub with its own machine tokens forwards to the parent; agents never receive the parent's token.
- **isolate**: remove inherited routing and use this instance's accounts or the provider's own credentials.

## Requirements

The shell prefix uses Claude's wrapper-enabled command and hook paths, which may differ in job handling, zsh setup and hook validation. Without an existing shell prefix or executable Bash/zsh, pooled Claude launches fail. Both bundles carry identical tested helpers without private workspace dependencies.

Use your own accounts only as permitted. Experimental: routing, storage and CLI may change.

## For agents

Thread availability is local to its environment's machine. `bb pool exec -- <codex|claude> ...` runs scheduled/supervised pooled work with [attempt receipts](RECEIPTS.md); see the skills.

`bb pool account add|login|list|remove|enable|disable|priority|reorder`, `bb pool status`, `bb pool routing <claude|codex> [--off]`, `bb pool config`, `bb pool config set`, `bb pool parent [proxy|isolate]`, `bb pool token rotate`, and `bb pool bypass <thread-id>`. Commands accept `--json` and `--help`; `bb pool --help` lists them.
