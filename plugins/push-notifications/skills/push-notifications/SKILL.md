---
name: push-notifications
description: "Register mobile devices, toggle mobile, web, and desktop notification channels, set per-thread notification levels, or test delivery for BB push notifications."
---

# Push notifications

The plugin notifies when a thread asks a question, finishes a turn, or stops on
an error. Mobile devices receive Expo push messages even when the app is
closed. Web and desktop clients receive system notifications only while a bb
tab or app window stays open, and each browser grants permission separately in
the plugin settings.

```sh
bb push-notifications status [--json]
bb push-notifications list [--json]
bb push-notifications add --token <expo-push-token> --platform <ios|android> --label <device-name> [--json]
bb push-notifications remove <id> [--json]
bb push-notifications test <web|desktop> [--json]
bb push-notifications thread <thread> [--level inherit|all|input-only|muted]
bb push-notifications notify --source <id> --kind blocker --title <text> --body <text> [--thread <id>] [--url </path>] [--dedupe-key <key>] [--json]
bb plugin config push-notifications set <mobileEnabled|webEnabled|desktopEnabled> <true|false>
bb plugin config push-notifications set defaultLevel <all|input-only|muted>
bb plugin config push-notifications set childLevel <inherit|all|input-only|muted>
bb plugin config push-notifications set blockerDailyCap <0-100>
bb plugin config push-notifications set expoPushUrl <url>
```

- `add` upserts by token: a known token refreshes its label and last-seen time
  and keeps its id. Expo tokens that are no longer registered are removed after
  a failed delivery.
- `list` shows token suffixes only.
- The three channel switches default to `true` and apply immediately to this
  server. `bb plugin disable push-notifications` stops all delivery.
- `test` broadcasts to every connected, permitted client of that type and
  fails when the channel is disabled. Success confirms the broadcast, not that
  the OS showed a banner; system notification settings can still suppress it.
- `thread` prints a thread's resolved notification level and its source;
  `--level` sets the thread's own level. A thread uses its own level, else
  `childLevel` if it has a parent (default `input-only`; `inherit` follows
  `defaultLevel`), else `defaultLevel` (default `all`). Every ancestor's own
  level also caps its child threads. `all` notifies on finished turns too,
  `input-only` keeps questions, approvals, and errors only, and `muted` sends
  nothing.
- `notify` pushes a blocker, a card or task that waits on a person, to the
  registered phones and to connected web and desktop clients. Only
  `--kind blocker` is accepted. At most `blockerDailyCap` blocker pushes go out
  per Pacific-time day across all sources together (default 3); beyond that, or for a repeated
  `--dedupe-key` that day, nothing is sent and the command still exits 0 with
  `capped` or `deduped` true in the JSON. `status` shows the last 14 days of
  sent, capped and deduped counts as a day total and per source. A plugin calls the same thing
  with `sdk.plugins.callRpc` and method `notifications.notify`; its source is
  its plugin id.

Inspect `status` before changing a channel, and change only the requested
channel or device.
