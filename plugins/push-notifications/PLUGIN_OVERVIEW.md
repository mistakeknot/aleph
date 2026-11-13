Notifications for questions, finished turns and errors; plugins and CLI can send too.

## Delivery

Mobile uses Expo, even when closed. Browser/desktop system notifications need a live connection; web needs HTTPS or localhost and permission. Mobile WebViews use push only.

Thread levels: `all` (questions, approvals, errors, finished turns), `input-only` (no finished turns), `muted`. A thread uses its own level, else `childLevel` if it has a parent, else `defaultLevel`; every ancestor's own level caps it. Muting a parent mutes its subtree; parents never make workers louder.

Clicks open the thread or bb; desktop restores focus. With `skipFocusedThreadNotifications` (on for early adopters), visible focused threads are not notified. Events coalesce, questions first. Read/archived/deleted/hidden threads are suppressed at every level; same-origin tabs deduplicate. With `dismissReadNotifications`, reading a thread removes its delivered notifications from mobile and open web/desktop clients.

## Thread menu

Unarchived threads offer **Notifications**: Default, All activity, Needs input only, Muted, showing parent limits. Only the own level is stored.

## Settings

- `mobileEnabled`, `webEnabled`, `desktopEnabled` (**Mobile**, **Web**, **Desktop notifications**): channels, default true.
- `defaultLevel` (**Default notifications**): `all`, `input-only`, `muted`; default `all`.
- `childLevel` (**Child thread notifications**): `inherit` (uses `defaultLevel`), `all`, `input-only`, `muted`; default `input-only`.
- `blockerDailyCap` (**Blocker pushes per day**): all-source cap per Pacific day; `0` disables. Default 3.
- `expoPushUrl` (**Expo push relay URL**): mobile relay, default `https://exp.host/--/api/v2/push/send`.

Settings → Push notifications applies immediately. Browser permission is per device via **Allow notifications**. **Send test notification** confirms broadcast, not OS display.

## CLI and SDK

`bb push-notifications` manages devices, status, sends, tests, blockers and thread levels; `bb plugin config push-notifications` changes settings. See the plugin skill. RPC `notifications.send` sends; `bb plugin rpc inspect push-notifications notifications.send` shows schemas.

## Blocker pushes

Plugins/scripts push blockers through the same sender/channels/devices, ignoring thread levels. All sources share `blockerDailyCap` per America/Los_Angeles day (23/25 hours at clock changes).

Plugins call `sdk.plugins.callRpc` method `notifications.notify` with `{ kind: "blocker", title, body, threadId?, dedupeKey? }`. The host sets `source` to the plugin id and refuses another; CLI/clients name their own, but new sources do not raise the cap. `threadId` must be `thr_` plus 10 valid characters or is refused before counting/sending. A source's repeated daily `dedupeKey` is not pushed twice. Title/body limits: 80/180 characters.

Results: `outcome` (`sent`, `capped`, `deduped`), `sentToday` (all-source daily total), `delivery` (null unless sent). Attempts consume the cap even if delivery fails or the thread is focused.

`bb push-notifications status --json` includes `blockerPush`: cap and last 14 days, newest first, with sent/capped/deduped counts per day/source. Capped sources without a sent push that day count under `_overflow`; each day has at most `blockerDailyCap` source rows plus `_overflow`.

## Measurement

`bb push-notifications counts --thread ID --json` or RPC `notifications.counts` reads persistent question/turn-end/error attempts per thread. Counts follow existing filtering/coalescing, once per alert across devices, including disabled channels and transport failures; they do not prove receipt. Manual/blocker/test/dismiss pushes are excluded. Storage holds counts and first/last timestamps, never message text. Deleted-thread totals remain during measurement. No push behavior or defaults change.
