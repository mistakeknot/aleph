# Account pool

`plugins/account-pool` serves Anthropic Messages and OpenAI Responses through a
local hub. Providers receive a hub URL and a machine-scoped token, and the hub
picks an account per request.

## Routing

- An account is skipped at or above the switch threshold, currently
  <!--fig:switch-threshold=0.98-->0.98 of a limit window, or when in error.
- A conversation keeps its account until it is unavailable. Pins expire after
  <!--fig:affinity-idle-minutes=65-->65 idle minutes and the hub retains the
  <!--fig:affinity-max-bindings=4096-->4096 most recently used.
- `bb pool exec -- codex ...` or `-- claude ...` runs a scripted process
  through the pool.

## Hub tokens

The hub token is delivered to a provider process as `ANTHROPIC_AUTH_TOKEN`
(Claude) or `CODEX_POOL_AUTH_TOKEN` (Codex). After `bb pool token rotate`, the
previous token stays valid for a grace period of
<!--fig:token-grace-minutes=10-->10 minutes.

## Nested bb servers

A bb server started inside a thread uses the parent's pool only if that thread
is listed in `nestedLaunchThreadIds`. The default is
<!--fig:nested-default=[]-->`[]`, which opts every thread out; other threads get

blank markers.

## Receipts

Attempt receipts give per-run accounting (account, model, usage). The wire
format is in `plugins/account-pool/RECEIPTS.md`.
