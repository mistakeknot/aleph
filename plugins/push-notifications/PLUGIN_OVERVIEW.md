Get a notification when an agent asks a question, finishes a turn, or stops on an error. Plugins and the CLI can send their own too. Choose mobile, web, and desktop delivery independently in Settings → Push notifications.

## Delivery

Mobile devices receive push messages through Expo, including when the app is closed. Web browsers and the desktop app receive system notifications over bb's live connection while a tab or window stays open; web delivery needs HTTPS (or localhost) and notification permission. Mobile WebViews use mobile push only.

Each thread has a level: `all` (questions, approvals, errors, finished turns), `input-only` (no finished turns), or `muted`. A thread uses its own level, else `childLevel` if it has a parent, else `defaultLevel`; every ancestor's own level caps it. Muting a parent mutes its whole subtree, but a parent never makes workers louder. The level applies on top of the suppressions below.

Click a notification to open its thread, or bb when it has none; on Linux desktop the click also restores and focuses the window. Events arriving together are combined, with pending questions taking priority. Read, archived, deleted, and hidden threads are suppressed. Tabs of the same origin deduplicate delivery.

## Thread menu

Every thread menu (header, sidebar row, right-click, compact drawer, optional row quick action) has a **Notifications** entry for unarchived threads: Default, All activity, Needs input only, Muted. The entry shows the current level; Default names its fallback; a footnote says when a parent limits it. Thread plugin metadata stores only a thread's own level, `{ "notifications": { "own" } }`; limits are read from the current parent chain. Menus fetch levels for threads on screen in batches.

## Settings

- `mobileEnabled` / **Mobile notifications**: send to registered phones and tablets. Default: true.
- `webEnabled` / **Web notifications**: notify connected browsers with permission. Default: true.
- `desktopEnabled` / **Desktop notifications**: notify running desktop clients. Default: true.
- `defaultLevel` / **Default notifications**: `all`, `input-only`, or `muted`, for threads you haven't set. Default: `all`.
- `childLevel` / **Child thread notifications**: `inherit` (same as `defaultLevel`), `all`, `input-only`, or `muted`. Default: `input-only`.
- `blockerDailyCap` / **Blocker pushes per day**: most blocker pushes sent in a local Pacific-time day, counted across all sources together; `0` turns them off. Default: 3.
- `expoPushUrl` / **Expo push relay URL**: mobile relay endpoint. Defaults to `https://exp.host/--/api/v2/push/send`.

Channel switches apply to this server and save immediately. Browser permission is granted per device with **Allow notifications**. **Send test notification** confirms broadcast, not OS display.

## CLI and SDK

`bb push-notifications` manages mobile devices, shows status, sends and tests notifications, pushes capped blockers, and reads or sets a thread's level; `bb plugin config push-notifications` changes the settings above. The bundled `push-notifications` skill documents every command and RPC method. Plugins and agents send notifications with the discoverable `notifications.send` RPC; `bb plugin rpc inspect push-notifications notifications.send` prints its schemas. Permission requests still require a click in the target client.

## Blocker pushes

Other plugins and scripts can push a blocker that needs a person, such as a card waiting on a decision. The push uses the same delivery as `notifications.send` and the event-driven pushes (the same sender, channels and subscriptions), to no other destination, and ignores thread levels. One daily cap covers all sources together: at most `blockerDailyCap` blocker pushes go out per calendar day in America/Los_Angeles (a day is 23 or 25 hours across a clock change), whichever source sends them.

Call it from a plugin with `sdk.plugins.callRpc`, method `notifications.notify`, input `{ kind: "blocker", title, body, threadId?, dedupeKey? }`. The source is the calling plugin's id, set by the host and not by the caller; a plugin that passes a different `source` is refused. The CLI and other clients name their own `source`, which is why the cap is a total across sources: inventing new source names does not raise it. `threadId`, when given, must be a bb thread id (`thr_` and 10 characters); anything else is refused as invalid input before it is counted or sent. A repeated `dedupeKey` from the same source on the same day is not pushed twice. `title` is cut to 80 characters and `body` to 180. The result is `{ id, at, day, source, outcome, capped, deduped, cap, sentToday, delivery }`: `sentToday` is the day's total across sources for every outcome, `outcome` is `sent`, `capped` or `deduped`, and `delivery` is null unless the push was sent. A push counts against the cap once it is attempted, even if the relay fails; the failure is in `delivery.mobileFailure`.

`bb push-notifications status --json` shows `blockerPush`: the cap, today's date, and the last 14 days, newest first, with `sent`, `capped` and `deduped` counts as a day `total` and for each source. Older days are deleted. A capped call from a source with no sent push that day is counted under the shared source `_overflow`, so callers cannot create a row by inventing a source name; at most `blockerDailyCap` source rows plus `_overflow` exist per day.
