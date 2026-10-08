Use your own Claude Code and Codex accounts, budgeted. The Account Pooler puts the accounts you own behind a local hub and applies the order and quota thresholds you set to each request.

## What you get

- Your own Claude and Codex accounts, added by importing the login already on the machine, signing in through the browser, or pasting an Anthropic API key.
- Accounts run one after another in priority order, with ties following the order added. New conversations stay on the current fallback even when an earlier account recovers. Existing conversations keep their own account until it becomes unavailable.
- Drag handles set the account order within each provider in settings (keyboard: Space to pick up, arrow keys to move, Space to drop, Escape to cancel), with the same operation available through `bb pool account reorder <claude|codex> <id>...`.
- Live limit windows per account and model family in the plugin's settings page, and the same numbers from `bb pool status`.
- A routing switch per provider and a bypass per thread, so one thread can go straight to its own credentials.

## How it works

The hub runs inside BB and serves Anthropic Messages and OpenAI Responses endpoints. With routing on, the provider receives a hub base URL and a machine-scoped token, and reports **Proxied**. An account is skipped at or above the switch threshold (98 percent of a window by default) or in error. Claude extra usage and Codex credits are fallbacks: usable subscription accounts come first, and conversations return when quota recovers. Exhausted accounts are rechecked before fallback. Codex spending-control and credit-depletion restrictions block routing even below the threshold. The pool never enables extra usage, buys credits, or changes spending limits; Settings shows "Extra usage available" only for reported allowance. Secrets stay on the server and refresh in the background.

The pool waits once on the same account for short rate limits. Longer holds return Retry-After for pinned conversations while new ones advance. A model-family limit detours that family without moving the session pin. A new account is committed after a successful response; the current account and session pins survive restarts and expire after 30 idle minutes (4,096 most recent kept).

The pool owns its upstream connections over HTTP/1.1, honors standard proxy environment variables, and logs connection failures as error codes without credentials or request contents.

## Nested bb servers

A bb server started inside another bb server's thread detects the parent's pooler and enables this plugin. Choose in settings or with `bb pool parent`:

- **proxy** (default): keep a local hub with its own machine tokens and forward traffic to the parent, so the parent's token never reaches this server's agents. Routing is contributed only for providers the parent can serve.
- **isolate**: neutralise the inherited routing and use this instance's own accounts, or each provider's own credentials.

Proxied traffic authenticates as the parent machine's token, so the parent attributes it to itself.

## Requirements

Accounts you own and are permitted to use this way.

This plugin is experimental. Routing, storage, and the CLI can change.

## For agents

Thread availability is answered only for the machine that owns the thread's environment. `bb pool exec -- <codex|claude> ...` runs scheduled or supervised work through the pool, with per-run accounting in [attempt receipts](RECEIPTS.md); the skills carry the detail.

`bb pool account add|list|remove|enable|disable|priority|reorder`, `bb pool status`, `bb pool routing <claude|codex> [--off]`, `bb pool config`, `bb pool config set`, `bb pool parent [proxy|isolate]`, `bb pool token rotate`, and `bb pool bypass <thread-id>`. Every command takes `--json` and `--help`; `bb pool --help` lists the commands and `bb pool <command> --help` prints its arguments, options, and rules.
