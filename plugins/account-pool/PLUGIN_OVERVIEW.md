Use your own Claude Code and Codex accounts, budgeted. The Account Pooler routes requests through a local hub using your account order and quota thresholds.

## What you get

- Add Claude and Codex accounts by importing a local login, signing in through the browser, or pasting an Anthropic API key.
- Accounts run by priority, then order added. New conversations stay on the current fallback even if an earlier account recovers; existing conversations keep their account until unavailable.
- Reorder accounts in settings by dragging, or with Space to pick up/drop, arrows to move, Escape to cancel. The CLI equivalent is `bb pool account reorder <claude|codex> <id>...`.
- View account and model-family limit windows in settings or `bb pool status`.
- Switch routing per provider or bypass it per thread to use that thread's own credentials.

## How it works

The hub runs inside BB with Anthropic Messages and OpenAI Responses endpoints. With routing on, the provider receives a hub URL and machine-scoped token and reports **Proxied**. Accounts at the switch threshold (98 percent by default) or in error are skipped. A refusal rechecks exhausted accounts so upgrades apply next turn. Secrets stay in the server's BB data directory and refresh in the background.

Short rate limits get one wait on the same account. Longer holds return Retry-After for pinned conversations; new conversations can advance. Model-family limits detour that family's requests without moving the session's main pin or provider cursor. A new account is committed only after a successful response; all-account failure retains the previous binding. Current accounts and session pins survive restarts. Pins expire after 30 idle minutes; up to 4,096 recent pins are retained.

The pooler uses its own HTTP/1.1 connections, honors standard proxy environment variables, and closes its transport on unload. It adds no request replay. Connection failures log known error codes when available, without bodies, credentials, URLs, or raw exception messages.

## Nested bb servers

A nested bb server detects the parent's pooler only in an opted-in thread. Set exact IDs with `bb pool config set nestedLaunchThreadIds '["thr_example"]'`; the default `'[]'` opts out all threads. Only listed threads currently served by the parent's pool receive parent markers; others receive blank markers, so launching bb there neither enables the pooler automatically nor proxies to the parent. Nested servers read markers once at startup. Changes apply to future agent starts; running sessions and nested servers keep their pairing. Each nested server has its own allowlist.

Markers carry the machine token already used for provider routing; the allowlist limits automatic pairing, not token access.

Choose in settings or with `bb pool parent`:

- **proxy** (default): forward through a local hub with its own machine tokens, keeping the parent's token out of this server's agents. Only providers the parent serves are routed.
- **isolate**: neutralise inherited routing and use local accounts or each provider's own credentials.

The parent attributes proxied traffic to its own machine token.

## Requirements

Accounts you own and are permitted to use this way.

Experimental: routing, stored data, and the CLI may change between releases.

## For agents

[Attempt receipts](RECEIPTS.md) provide per-run accounting.

Commands: `bb pool account add|list|remove|enable|disable|priority|reorder`, `status`, `routing <claude|codex> [--off]`, `config`, `config set`, `parent [proxy|isolate]`, `token rotate`, and `bypass <thread-id>`. All take `--json` and `--help`; `bb pool --help` lists commands.
