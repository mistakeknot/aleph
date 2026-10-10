Keep Claude Code or Codex running across account limits. The Account Pooler picks an account per request through a local hub.

## What you get

- Add Claude and Codex accounts by importing a local login, signing in through the browser, or pasting an Anthropic API key.
- Accounts run by priority, then order added. New conversations stay on the fallback even if earlier accounts recover; existing ones keep their account until unavailable.
- Reorder each provider's accounts by dragging in settings, or with Space to pick up/drop, arrows to move, Escape to cancel. CLI: `bb pool account reorder <claude|codex> <id>...`.
- View live account and model-family limit windows in settings or `bb pool status`.
- Switch routing per provider or bypass it per thread to use that thread's own credentials.

## How it works

The hub serves Anthropic Messages and OpenAI Responses inside BB. With routing on, providers receive a hub URL and machine-scoped token and report **Proxied** in their health row. Skip accounts at or above the switch threshold (98 percent of a window by default) or in error. A refusal rechecks exhausted accounts so upgrades apply next turn. Secrets stay in the server's BB data directory and refresh in the background.

Short rate limits get one wait on the same account. Longer holds return Retry-After for pinned conversations; new conversations can advance. Model-family limits detour that family's requests without moving the session's main pin or provider cursor. Commit a new account only after a successful response; all-account failure retains the previous binding. Accounts and session pins survive restarts. Pins expire after 30 idle minutes; retain the 4,096 most recently used.

The pooler uses its own HTTP/1.1 connections, avoiding broken shared HTTP/2 sessions. It honors standard proxy environment variables and closes on unload. It adds no request replay; account-fallback rules still apply. Pooled request connection failures log known error codes when available, without bodies, credentials, URLs, or raw exception messages.

## Nested bb servers

A bb server started in an opted-in parent thread detects the parent's pooler and enables this plugin. Set exact IDs with `bb pool config set nestedLaunchThreadIds '["thr_example"]'`; `'[]'` (default) opts out all threads. Only listed threads currently served by the parent get markers; others get blank markers, so launching bb there neither auto-enables the pooler nor proxies to the parent. Markers are read once at startup. Allowlist edits affect future agent starts; running sessions and nested servers keep their pairing. Each nested server has its own allowlist.

Markers carry the machine token already used for provider routing; the allowlist limits automatic pairing, not token access.

Choose in settings or with `bb pool parent`:

- **proxy** (default): forward through a local hub with its own machine tokens, keeping the parent's token out of local agents. Only providers the parent serves are routed.
- **isolate**: neutralise inherited routing and use local accounts or each provider's own credentials.

Proxied traffic authenticates with the parent's machine token and is attributed to that machine.

## Requirements

Accounts you own and are permitted to use this way.

Experimental: routing, stored data, and the CLI may change between releases.

## For agents

[Attempt receipts](RECEIPTS.md) provide per-run accounting.

Commands: `bb pool account add|list|remove|enable|disable|priority|reorder`, `bb pool status`, `bb pool routing <claude|codex> [--off]`, `bb pool config`, `bb pool config set`, `bb pool parent [proxy|isolate]`, `bb pool token rotate`, `bb pool bypass <thread-id>`. All take `--json` and `--help`; `bb pool --help` lists commands; `bb pool <command> --help` gives arguments, options, and rules.
