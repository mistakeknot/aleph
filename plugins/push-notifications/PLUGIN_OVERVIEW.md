Notifications for agent questions, finished turns and errors; plugins and CLI can send too.

## Delivery

Mobile push uses Expo, even with the app closed. Browsers and desktop use system notifications over the live connection; web needs HTTPS (or localhost) and permission. Mobile WebViews use mobile push only.

Each thread has a level: `all` (questions, approvals, errors, finished turns), `input-only` (no finished turns), or `muted`. It uses its own level, else `childLevel` if it has a parent, else `defaultLevel`; every ancestor's own level caps it. Muting a parent mutes its subtree; a parent never makes workers louder.

Clicking opens the thread, or bb if none; desktop also restores and focuses the window. With the `skipFocusedThreadNotifications` experiment (on for early adopters), a thread open in a visible, focused window or tab is not notified. Events combine, pending questions first. Read, archived, deleted, and hidden threads are suppressed at every level; tabs of one origin deduplicate.

## Thread menu

Every thread menu has a **Notifications** entry for unarchived threads: Default, All activity, Needs input only, Muted. It shows the current level, and a footnote says when a parent limits it. Only the thread's own level is stored; limits come from the parent chain.

## Settings

- `mobileEnabled`, `webEnabled`, `desktopEnabled` (**Mobile**, **Web**, **Desktop notifications**): channel switches. Default: true.
- `defaultLevel` (**Default notifications**): `all`, `input-only`, or `muted` for threads you haven't set. Default: `all`.
- `childLevel` (**Child thread notifications**): `inherit` (as `defaultLevel`), `all`, `input-only`, or `muted`. Default: `input-only`.
- `blockerDailyCap` (**Blocker pushes per day**): blocker pushes per Pacific-time day, all sources; `0` turns them off. Default: 3.
- `expoPushUrl` (**Expo push relay URL**): mobile relay. Default: `https://exp.host/--/api/v2/push/send`.

Settings → Push notifications applies to this server immediately. Browser permission is per device, via **Allow notifications**. **Send test notification** confirms broadcast, not OS display.

## CLI and SDK

`bb push-notifications` manages devices, shows status, sends and tests notifications, pushes capped blockers, and reads or sets a thread's level; `bb plugin config push-notifications` changes settings. The `push-notifications` skill documents commands and RPCs. The `notifications.send` RPC sends notifications; `bb plugin rpc inspect push-notifications notifications.send` shows its schemas. Permission requests still need a click in the target client.

## Blocker pushes

Plugins and scripts can push blockers needing a person. It uses the sender, channels and subscriptions of `notifications.send`, goes nowhere else, and ignores thread levels. One cap covers all sources: at most `blockerDailyCap` per America/Los_Angeles day (23 or 25 hours at clock changes).

Plugins call `sdk.plugins.callRpc` method `notifications.notify` with `{ kind: "blocker", title, body, threadId?, dedupeKey? }`. The host sets `source` to the plugin's id and refuses another; the CLI and other clients name their own, but new names do not raise the cap. `threadId` must be a bb thread id (`thr_` plus 10 characters), else it is refused before it is counted or sent. A repeated `dedupeKey` from a source that day is not pushed twice. `title` is cut to 80 characters, `body` to 180.

Results include `outcome` (`sent`, `capped` or `deduped`), `sentToday` (the day's total across sources) and `delivery` (null unless sent). Attempts count against the cap even if the relay fails or the blocker targets a focused thread.

`bb push-notifications status --json` shows `blockerPush`: the cap and the last 14 days (newest first), with `sent`, `capped` and `deduped` counts per day and per source. Older days are deleted. A capped call from a source with no sent push that day counts under `_overflow`; a day has at most `blockerDailyCap` source rows plus `_overflow`.
