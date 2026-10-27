# Aleph

Aleph is mk's fork of [bb](https://github.com/get-bb/bb), maintained at
`mistakeknot/bb`. The name comes from the Aleph in William Gibson's _Mona Lisa
Overdrive_ and from Jorge Luis Borges' story "The Aleph".

Aleph keeps bb's package names (`bb-app`, `@bb/desktop`, plugin packages) and
command names (`bb`, `bb-app`). Only the version and this file identify the
fork.

## Versions

Aleph releases are named `aleph-X.Y.Z`, for example `aleph-0.4.1`. `X.Y.Z` is
Aleph's own version. The package version keeps the upstream bb release Aleph is
based on as its semver version and carries the Aleph version in build metadata:
`0.43.4+aleph.0.4.1` is Aleph 0.4.1 on upstream bb 0.43.4. The changelog entry
for each Aleph version names the upstream main commit it includes.

Releases before 0.4.1 used a build number instead, `<upstream>+aleph.<n>`, for
example `0.43.4+aleph.4`. That build number `n` counts as Aleph `0.n.0`, so
aleph.4 is Aleph 0.4.0 and the next release is 0.4.1.

The next versions go like this:

- **Patch, `0.4.1` to `0.4.2`.** Fixes and small Aleph changes on the same
  upstream base: `0.43.4+aleph.0.4.2`. Run
  `node scripts/bump-version.mjs --patch`.
- **Minor, `0.4.x` to `0.5.0`.** New Aleph features: `0.43.4+aleph.0.5.0`. Run
  `node scripts/bump-version.mjs --minor`.
- **New upstream base.** Moving to a newer upstream bb release changes the
  semver part and bumps the Aleph minor version, because an upstream sync brings
  in upstream's features. After syncing upstream 0.44.0 onto Aleph 0.5.0, the
  version is `0.44.0+aleph.0.6.0`. Pass it explicitly:
  `node scripts/bump-version.mjs 0.44.0+aleph.0.6.0`. An upstream sync takes
  upstream's `package.json` version, which has no `+aleph` metadata, so set the
  version before building.

`--major` bumps the Aleph major version. The flags never change the upstream
base.

Aleph's version, not semver, orders Aleph releases. The `+aleph.X.Y.Z` part is
semver build metadata, and semver ignores build metadata when comparing
versions:

- Upstream `0.43.4` compares equal to `0.43.4+aleph.0.4.1`, and upstream
  `0.43.5` compares newer. Upstream's update checks would therefore offer
  0.43.5, and installing it would replace Aleph. Aleph builds turn those checks
  off (see [Updates](#updates)).
- `0.43.4+aleph.0.4.2` does not compare newer than `0.43.4+aleph.0.4.1` in
  semver. `scripts/bump-version.mjs` therefore compares Aleph versions by their
  Aleph release instead. It requires a greater Aleph release, refuses an older
  upstream base, and refuses a version without `+aleph.X.Y.Z`, which would turn
  upstream updates back on. It reads an old `+aleph.<n>` version as `0.n.0`.
  `.github/workflows/check-version-lockstep.mjs` checks that
  `packages/bb-app/package.json` and `apps/desktop/package.json` match.
- `npm pack` keeps the metadata in the tarball name, for example
  `bb-app-0.43.4+aleph.0.4.1.tgz`. The npm registry drops build metadata, so an
  Aleph version cannot be published under the upstream `bb-app` package name.

The desktop app's About panel shows the Aleph version first, for example
"Version 0.4.1 (0.43.4+aleph.0.4.1)". The web app and `bb` CLI show the full
package version.

## Updates

An Aleph build never offers an upstream release. `isAlephAppVersion` in
`packages/config/src/aleph-version.ts` looks for `aleph` in the version's build
metadata, and when it finds it:

- The server skips its npm lookup of `bb-app`. `/api/v1/system/version` returns
  `updateChecksDisabled: true` and no `upgradeCommand`, and an in-app npm
  update is refused with 409 because there is nothing to install.
- The desktop app turns off both its `desktop-latest` feed check and
  electron-updater, so it neither shows nor downloads an upstream release.

The guard fails open: a version without the suffix, for example after an
upstream sync that takes upstream's `package.json` version, turns every update
path back on. `packages/config/test/aleph-release-version.test.ts` fails when
`bb-app`, `@bb/desktop` or the newest `changelog-metadata.ts` release lacks
`+aleph.X.Y.Z`.

Settings → Updates and `bb updates` show "Update checks off" for the generic
bb app check instead of "Up to date", because no upstream release was checked.
The separate Aleph row reports the [signed channel](#signed-update-channel).

Updating Aleph follows the signed release channel, or a newer Aleph build
installed by hand:

- **Server.** Where the signed update service is installed, the signed channel
  offers the update in Settings → Updates, signed in as the owner. Without it,
  the row shows the command to run from a root shell, and `bb updates aleph`
  and `bb updates aleph run <nonce>` report the same status read-only. Otherwise
  install `bb-app` from `npm pack`. The generic source updater is suppressed on
  an Aleph build: a source checkout started with `--in-app-updates` neither
  offers nor applies a fast-forward to `origin/main`, and the launcher refuses
  it, so update a source checkout by hand and restart.
- **Macs running the desktop app.** Build and install the desktop app (below).
- **Machines enrolled with a launchd or systemd daemon.** These do not follow
  the server. A daemon updates itself only when the server speaks a newer
  host-daemon protocol, and most Aleph releases keep the protocol. When a
  release changes daemon code, rerun the machine's install command, which
  `bb machine reconnect <machine>` prints on the server. The installer fetches
  the server's own `bb-app`. If that download fails, it falls back to a `bb-app`
  already on the machine's PATH, or to upstream from npm, so check the version
  it reports.

### Signed update channel

The Aleph channel describes releases in a canonical `aleph-manifest/2`
manifest. Each entry identifies the Aleph release, upstream base, source
commit, toolchain, host protocol, ordered database migrations, qualification
jobs, review receipt and platform artifacts. A Linux closure's archive digest
must match its qualification digest. A Mac artifact carries a
`maintainer-receipt` attestation and its receipt digest. These records bind a
release to evidence; accepting a manifest does not run qualification or install
anything.

`packages/bb-app/scripts/release-lock.mjs` requires the running npm to match
the exact `dependencies.npm` pin in the package manifest and refuses a
different version. It removes development dependencies from a temporary copy
of the packed manifest and converts the generated package lock to
`npm-shrinkwrap.json`. In `check` mode, the packed package must include that
shrinkwrap; `generate` mode can create it when absent. Both modes reject a
pack listing containing `package-lock.json`. The smoke script,
`packages/bb-app/scripts/smoke-tarball.mjs`, accepts
`--installed-prefix <prefix>` to test an already-installed package and its
native modules without packing or installing another copy. The release recipe
still has to qualify the archive that the helper will install.

The manifest and its detached SSHSIG signature live together under
`gen/<sequence>-<digest12>/` as `manifest.json` and `manifest.json.sig`, where
`digest12` is the first 12 lowercase hexadecimal characters of the digest.
`current.json` points to that directory; the pointer is unsigned and does not
make a generation trusted. Artifact files live under `artifacts/<sha256>/`.
The server reads the selected generation from the configured publication
directory, whose default is `/srv/aleph-update/public`.

Verification uses the `aleph-update-manifest` namespace and pinned
`sk-ssh-ed25519@openssh.com` signers. Both the user-presence and user-verified
signature flags are required, and the verified fingerprint must match the
manifest's `signer_fingerprint`. Signer entries have a `valid-after` boundary
and may have `valid-before`; multiple pinned entries allow a rotation overlap.
The helper's admission tooling rejects a manifest signature larger than
16384 bytes.

Each consumer starts from a pinned floor and retains the accepted sequence,
digest, issue time and manifest bytes. A lower sequence, an older issue time,
or different bytes at the same sequence is refused. A manifest may be issued
at most five minutes ahead of the verifier's clock, must remain unexpired,
and may cover at most 35 days. Existing release entries cannot change or
disappear in a later accepted generation; revocations accumulate. An offline
consumer cannot learn a revocation until it observes a newer generation.

The channel compares Aleph releases numerically, component by component,
after extracting `aleph.X.Y.Z` from package build metadata. A legacy
`+aleph.N` install is `not-comparable` to this channel. Upstream semver and its
build-metadata ordering do not choose the Aleph target. The selector needs a
consistent manifest entry for the installed release. It considers only newer,
unrevoked entries with an artifact for the current platform and reports the
highest such release as `available` only when every migration's tag,
timestamp and SQL digest matches the installed entry in order. A difference
reports `migration-required`; the button cannot apply it. Installed
revocations are reported separately. A missing or inconsistent installed
entry is `not-comparable`.

Settings → Updates shows a separate Aleph row, independent of the generic
launcher's update support. `GET /api/v1/system/aleph-update`, `bb updates aleph`
and `bb updates aleph run <nonce>` expose status without starting an update.
The row shows the manifest sequence and age, installed release, predecessor,
active-thread count and explicit manifest or recovery errors. A status read
may advance the advisory manifest floor; it does not switch the installation.

The system helper is configured separately. Its capability is `absent` when
the unit template is missing, `command-only` when the template exists without
a matching capability declaration, and `startable` when the declaration
contains `polkit-start/1` and the installed rule's digest. That declaration is
advisory, not proof of authorization. A denied start returns 409 with the
command for an operator to run from a root shell.

Requests use `aleph-update@<instance>.service`, with these instance forms:

```text
update_<version>_<digest>_<consent>_<nonce>
rollback_<from>_<to>_<consent>_<nonce>
recover_<nonce>
adopt_<version>_<digest>_<consent>_<nonce>
```

Versions have three decimal components, each one to four digits with no
leading zero except `0`. Digests are 64 lowercase hexadecimal characters;
nonces are 32. Consent is `n` for waiting without interruption or `i` for
explicit interrupt consent. The digest binds an update to the manifest the
user saw. `adopt` is reserved for the operator's root command; the server
exposes only update, rollback and recover. The shared grammar is
`packages/config/src/aleph-update-instance-grammar.json`.

Before posting, the browser saves the nonce and request body. Reconnecting
polls `GET /api/v1/system/aleph-update/runs/<nonce>`; a retry keeps the original
nonce and body. An existing run takes precedence over a later refusal record,
and a repeat request returns the original status without starting another
operation. Missing status or a disconnected browser is not a success result.

Each mutation requires a `session` gate marker, the app's Origin,
`x-aleph-update: 1` and the operation's `confirm` value. The connect relay
strips caller-supplied gate headers and supplies the session marker after
checking the owner's cookie. The server trusts that marker; it does not
authenticate it independently. A local process able to reach the server's
loopback listener can forge it. Ordinary CLI requests without the marker,
machine credentials and cross-origin browser requests are refused.

The helper owns installation admission and recovery state. A channel update
does not authorize a database migration. Rollback returns to the recorded
predecessor's code with matching migrations and preserves newer data; a
database restore is a separate operator decision. Recovery verifies the
installation recorded by the helper, rather than selecting another release.
Release publication, helper setup and desktop installation remain separate
operator steps.

### Update request notices and audit

Every Aleph update request POST writes a row to `aleph-update/audit.jsonl` in
the server data directory, holding the time, instance, nonce, operation and
outcome. The server writes a `requested` row before it starts anything and
refuses the request with 503 when it cannot, so no update starts unrecorded.
In the settings row, a request whose browser clock moved backward while the
page was closed is reported as outcome unknown straight away.
The outcome row after the start is queued and retried if the write fails.

Set `ALEPH_UPDATE_NOTIFY_COMMAND` to a JSON array, for example
`["/usr/local/bin/notify-admin"]`, to be told about each request. The server
runs that fixed argv without a shell, sends one line of at most 512 bytes on
stdin (`Aleph update request <nonce>: <outcome>`) and kills the command after
five seconds. The command gets only `PATH`, `HOME` and `LANG` from the
server's environment. A request refused because its audit row could not be
written still sends a notice, with the outcome `audit-unavailable`. When it is
unset, empty or not a non-empty string array, no
notice is sent.

### Build the macOS desktop app

A desktop app's local host daemon runs the `bb-app` bundled inside the app. A
Mac connected to an Aleph server therefore needs an Aleph desktop build at the
server's version. With stock bb, the server rejects the daemon for a
host-daemon protocol mismatch. On the Mac, at the server's commit:

```sh
# Node 22 (.nvmrc) and pnpm 9.15.0 (packageManager)
pnpm install --frozen-lockfile
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @bb/desktop run package
codesign --force --deep --sign - apps/desktop/release/mac-arm64/Aleph.app
```

Do not use `dist` or `desktop:build`; both pass `--publish always`. Before
installing, check that
`Aleph.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/package.json`
has the server's version. Then quit bb. A stock bb may have downloaded an upstream
update that it installs on quit, so let that finish before the swap. Move the old
`/Applications/bb.app` or `/Applications/Aleph.app` aside, copy the new one in, and
run `xattr -dr com.apple.quarantine /Applications/Aleph.app`. Enrollment lives in
`~/.bb`, outside the bundle, so it survives the swap.

Every copy of the app shares the bundle id `dev.bb.desktop` (see below), and
`open /Applications/Aleph.app` can launch whichever copy LaunchServices has
registered for that id, for example the build output. After the swap, unregister
the other copies, register the installed one, launch it by path, and check which
binary runs:

```sh
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREG" -u apps/desktop/release/mac-arm64/Aleph.app
"$LSREG" -u ~/bb.app.moved-aside   # each moved-aside bb.app or Aleph.app
"$LSREG" -u ~/.Trash/Aleph.app     # and any copy in the Trash
"$LSREG" -f /Applications/Aleph.app
open /Applications/Aleph.app
ps -axo comm= | grep -E '/Contents/MacOS/(bb|Aleph)$' | sort -u
lsappinfo info -only bundlepath -app dev.bb.desktop
```

Unregister the build output before the swap as well, so nothing launches it
while `/Applications` is empty. To list every registered copy:
`"$LSREG" -dump | awk '/^path:/{p=$0} /^identifier: +dev\.bb\.desktop$/{print p}'`. The app can take several seconds to start. The
`ps` command must then print only `/Applications/Aleph.app/Contents/MacOS/Aleph`,
and `lsappinfo` must print `/Applications/Aleph.app`. If either shows another
path, quit that app, unregister its copy, and launch again. To roll back, quit
Aleph, move the new app out, move the old copy back, and repeat the
`lsregister -u`/`-f` steps for the two copies.

#### Desktop app naming

The packaged app shows as "Aleph" — Dock, Cmd-Tab, the app menu, the About
panel, and window titles — everywhere `apps/desktop/scripts/desktop-release-channel.mjs`
and `apps/desktop/src/desktop-update-provider.ts` resolve a release channel.
Both derive an `"aleph"` channel automatically from a `+aleph` package
version, alongside the existing `"latest"`/`"nightly"` channels, so no build
flag is needed. Rather than scattering `bb`/`Aleph` string edits, add a new
channel branch here when something else needs to differ for Aleph builds.

The macOS bundle id (`dev.bb.desktop`) and the userData folder name (`bb`)
stay the same as stock bb: safeStorage-backed secrets and TCC grants are
scoped to the bundle id, and an aleph.1/aleph.2 install already used that
userData folder, so keeping both means an existing install's settings and
sign-in survive the rename with no migration step. Only `productName`, the
artifact name, the Linux executable name, and window/menu titles change. The
CLI command name and host daemon are unaffected; this only renames the
desktop app.

A Mac can also have an enrolled launchd daemon (`launchctl list | grep
app.getbb.host-daemon`). That daemon, not the app's, then connects to the
server and runs `bb-app` from `~/.bb/npm`, so the new app does not update it.
Update it as an enrolled machine, above.

## Carried patches

Beyond upstream, Aleph carries:

- **Account Pooler 0.1.2.** Thread availability bound to the thread's owning
  machine (403 on refusal, 503 on failed lookups, no caching); `bb pool exec`
  for Codex and Claude, with an argument allowlist, the transport marker
  and a host-private stdin directory; and attempt receipts for budgeted
  dispatch. Its contract is `plugins/account-pool/RECEIPTS.md`.
- **Thread list.** Provider icons with brand, monochrome, theme or custom
  colors.
- **Split panes.** Optional composer focus when switching panes with the
  keyboard.
- **Renderer diagnostics log (mk-h1q8).** Aleph-only file sink
  `~/Library/Logs/Aleph/aleph-renderer-YYYY-MM-DD.log` (daily, 5 days kept,
  5 MiB per file), gated on `BB_DESKTOP_RELEASE_CHANNEL=aleph`. Records
  renderer console warnings and errors as a category and code only, socket open/close/replace,
  reconnect invalidation decisions, thread sequence anomalies and
  composer send-state changes as ids and enumerated states only. Shared
  code carries a sink-less emitter (`apps/app/src/lib/diagnostics.ts`) with
  call sites in `ws.ts`, `system-cache-effects.ts`,
  `ThreadDetailPromptArea.tsx` and `App.tsx`; everything else lives in
  `apps/app/src/aleph/` and `apps/desktop/src/aleph-renderer-log*.ts`.
  Carried commits: see `git log --grep 'mk-h1q8'`.
- **Composer-stuck fixes (mk-h1q8).** Reconnect invalidation skips only
  queries fetched at or after the reconnect-open time (was: after the
  disconnect), in-flight thread-scoped fetches get one trailing refetch when
  they settle. Sending stays blocked until a successful pending-interactions
  result for the thread: `useThreadPendingInteractions` has a 5 s request
  timeout classified as a transient read error (2 retries at 250 ms), polls
  every 5 s while in the error state, and the composer shows a "Couldn't check
  for pending approvals. Retry" row. Recovery from one hung fetch takes about
  5.3 s; from fully hung fetches the Retry row appears after about 15.5 s.
  Logic is in `apps/app/src/aleph/pending-interactions-guard.ts` and
  `reconnect-trailing-refetch.ts`; shared code touched is the client-core
  `pending-interactions-check-failed` blocked reason and
  `onRetryPendingInteractions` argument, and `isTransientReadError`.
- **Model picker.** Switching a thread's provider in place when the local
  handoff plugin is running.
- **No upstream update offers.** See [Updates](#updates).
- **Release qualification.** `scripts/ci-release-check.sh`, run by the
  fork's CI worker in a credential-free guest.
- **Thecla theme, default for new installs.** A built-in palette (rose,
  orchid pink, and cyan on deep black) that new installs and never-configured
  users start on; anyone who has explicitly picked a theme, including the
  upstream Default, keeps it. `bb theme reset` resets to Thecla; Default
  remains selectable. Thecla's font stack asks for "Ioskeley Mono" first,
  falling back through Iosevka, JetBrains Mono, and the platform generic
  monospace stack. The server downloads a pinned, sha256-verified,
  OFL-1.1-licensed release of Ioskeley Mono into the data dir on startup and
  serves it same-origin; the font is never committed to the repo, and a
  failed or offline download just leaves Thecla on its fallback fonts.
- **Dorcas theme, for OLED screens.** A built-in sibling of Thecla that
  limits burn-in: dimmer text and accents on true black, and borders and
  input outlines that drift slowly between rose and cyan on an 18-minute
  cycle, stepped every 30 seconds and shared by every open window. The sidebar
  and page headers fade to 30% while a window is in the background or after a
  minute without input, and come back on hover, focus or input. After 5
  minutes without input a window dims to about a third of its brightness, and
  any input restores it. The drift stops under the reduced-motion setting, and
  the drift, fading and dimming are off under forced colors. Select it with
  `bb theme set dorcas`.

- **Agent process priority.** The host daemon raises host plugin workers and
  terminal PTYs to `BB_AGENT_NICE` (default 10, 0 disables, capped at 19)
  after spawning them, so agent workloads cannot starve the server's event
  loop on a shared CPU. It only raises the nice value and skips Windows
  (`apps/host-daemon/src/agent-process-priority.ts`).

- **Account Pooler stall tolerance (0.6.3).** The upstream transport gives
  each per-address connect attempt 5 s, below undici's 10 s connect timeout,
  so event-loop stalls no longer abort dual-stack connects
  (`plugins/account-pool/src/upstream-transport.ts`). Receipt evidence
  hoists its schemas to module scope and skips frames whose `type` carries no
  evidence (`plugins/account-pool/src/receipts.ts`).

- **Backported upstream performance fixes (0.6.3).** Nine upstream bb commits
  cherry-picked ahead of the next sync: #4718, #4751, #4931, #5112, #5115,
  #5116, #5120, #5121 and #5240. Each records its upstream commit in a
  `(cherry picked from commit ...)` line; the next upstream merge brings the
  same changes and should take upstream's side. #5240 keeps the fork's
  timeline build coalescer in the timeline route.

`git log --no-merges <upstream main>..HEAD` lists the carried commits.
Upstream is merged into Aleph, not rebased, and each merge commit records its
conflicts.

## Fork-owned migrations

`0132_aromatic_alice` and `0133_hot_joshua_kane` are the first Drizzle
migrations Aleph owns rather than carries from upstream; they back the
Account Pooler's idempotency table. Drizzle applies a migration only when its
journal `when` timestamp is greater than the largest `created_at` already
applied, so these two now occupy that point in the timestamp order for every
Aleph host.

This means an upstream sync can no longer append migrations past 0131
without checking timestamps first: any incoming upstream migration whose
`when` predates 0133's (currently 1790350024036) sorts before it. Drizzle
then skips it as already applied, `validateAppliedMigrationHistory` throws
"Database migration history is incomplete", and the server refuses to boot.
Before merging an upstream sync that adds migrations, check each new
migration's `when` in `packages/db/drizzle/meta/_journal.json` against
0133's. Regenerate and renumber any that predate it (with
`drizzle-kit generate`, then rewrite the journal entry and SQL filename to
sort after 0133), or repair an already-shipped mismatch with a shim like the
existing `repairBranchLocal*` migrations. Skipping this check is a boot
outage, not a merge conflict, so nothing else surfaces it beforehand.

The fork now owns 0132 to 0134 (0134's `when` is 1790477193524). The 0.45.0
sync (mk-09dq) brought six upstream migrations whose upstream numbers were
0132 to 0137 and whose first `when` predated 0134. They were renumbered to
0135 to 0140 with their SQL unchanged, `0135_thread_drafts`'s `when` moved to
1790477193525, and their snapshots carry the fork's tables and columns. A host
that has run 0135 or later cannot go back to a 0.5.x build:
`validateAppliedMigrationHistory` refuses migrations it does not know, so
rolling back means restoring a database backup taken before the switch.

The 0.47.0 sync brought upstream migrations 0144 to 0146 into the tail of
`drizzle/`. Their upstream `when` values predate `A0010`'s (1792668833813), so
`requireIncreasingWhen` in `migration-guard.ts` would refuse the plan. Their
journal `when` values were raised to 1792668833814 through 1792668833816 with
the SQL unchanged. Repeat this on the next sync for any upstream step whose
`when` is not above the preceding ceiling.

Upstream 0144 adds `threads.parent_notifications`, and `threads` is an
Aleph-altered table, so `guardUpstreamStep` refuses it unless it is frozen and
superseded. `A0011_thread_parent_notifications` carries the same `ALTER TABLE`
as a fork step that supersedes 0144; 0144 to 0146 are listed in
`frozen-upstream.json`, and `step-checks.json` declares the tables A0011
writes. The legacy oracle in the db tests stays at 0.46.1 (153 steps); tests
that compare against it replay the three later upstream steps with
`applyPostOracleSteps`.

### Namespaced migration runner (mk-knexd)

`packages/db/src/migration-runner.ts` (with `migration-plan.ts`,
`migration-ledger.ts`, `migration-backup.ts`, `migration-restore.ts`,
`migration-lock.ts`, `migration-guard.ts`, `migration-history.ts`,
`migration-step-checks.ts` and `legacy-migration-chain.ts`) replaces the single
Drizzle journal with two namespaces: the frozen upstream folder
(`drizzle/`, pinned by `drizzle-aleph/frozen-upstream.json`) and the
fork-owned folder `packages/db/drizzle-aleph/` (`A0001` to `A0011`, ordered by
`manifest.json`, checked by `step-checks.json`; `A0010` is the event cold tier that
main carries as upstream-numbered `0152_event_cold_tier`, which the legacy chain
maps to it). Applied steps are recorded in
`__bb_migration_ledger`, and `__drizzle_migrations` stays as a compatibility
log. Before the first namespaced run the runner takes a verified backup
(`.pre-ns-*` plus `.sidecar.json`) and migrates under the migrating lock.

Sync rule. An upstream migration after the frozen set is accepted without
manual work only while all of these hold: `guardPlan` in
`packages/db/src/migration-guard.ts` passes (frozen-set verification, the
undeclared-candidate checks on guarded tables, and the collision and equality
tests in `packages/db/test`); the candidate's `when` is strictly greater than
every preceding step's, which `requireIncreasingWhen` in the same file
enforces (currently above A0010's 1792668833813, so the timestamp check in
"Fork-owned migrations" above still applies, but a failure is a named refusal
at plan load rather than a boot outage); and the review is clean. Anything
else is a manual step.

Accepted residuals (R-numbers are the build's review labels; each is recorded
here, and none blocks the release):

- R1: the byte-identical `drizzle/` test needs the 411eac54 Git objects, so it
  runs only in a clone that has them.
- R2: data-only Aleph steps are invisible to `aleph-altered-tables.json`.
- R3: a new upstream `CREATE TRIGGER`, `VIEW` or `INDEX` on a guarded table is
  not blocked. R6: `DROP TRIGGER`, `INDEX` and `VIEW` return no affected
  tables.
- R4 (retired): the transitional-cache production helper was deleted; the
  test oracle's cache validates against Git.
- R5 and R8: circular or unresolvable views, and views that call custom SQL
  functions, widen the guarded set (conservative).
- R7, R9 and R10: TEMP-table tracking is limited. An unqualified `ALTER` of a
  temp-created `__new_` table is ignored, any `ROLLBACK` token clears the
  tracking, and `CREATE TEMP ... IF NOT EXISTS` is not tracked.
- R11: the step 3 harness is not cited for D2, D3 and D4.
- R12: frozen steps are trusted by hash; the runtime does not rescan them for
  control characters. R13 is not a gap: the refusal does apply to Aleph steps
  through `readAlephSql`.
- R14: A0009's `writesTables` exempts `transfer_entries` and `transfer_events`
  from digest equality, because its trigger closure writes them.
- Guard behaviour: Aleph statements that fail with "no such table, column,
  index or view" (targets only a candidate creates) are skipped, so the
  protected set comes from trusted schemas only and the skip over-protects;
  there is no strict candidate-inclusive model. `tablesNamedBy` accepts any
  identifier that resolves even when the mutation target is unknown, so an
  unknown target is not distinguished from a known one. `isLiteralString`
  still over-guards. The case-only false refusal is still recorded, not retired: `foldName`
  folds identifiers by ASCII case, so a drop and recreate that differs only in
  case can be refused falsely; the identifier diff is textual. Aleph steps are built
  unconditionally in the guard models. Undeclared non-frozen Aleph steps
  (`A0010` and later) get an empty declaration and are strict by design. FK
  identity capture counts only orphans. NULL `created_at` compat rows are
  ignored, as the legacy validator ignores them.
- Rowids: NULL-key rows are excluded from the rowid check. For a table whose
  columns shadow `rowid`, `_rowid_` and `oid`, backup creation succeeds, and
  digest finalization returns status "basic" and keeps the backup with its
  digests pending; the step checks (`migration-step-checks.ts`) and the restore
  (`migration-restore.ts`) refuse such a table by name because they cannot
  read its rowids. The 4(b) count-bounded keyless rule is not implemented (the
  build's Step 4 residuals are the guard behaviours above and this rule, so no
  separate list exists), and `preservedKey` is implicit.
- Restore takes FTS5 tables only in forms known to round-trip.
  `CONTENT_PROJECTION` stays content-v2.
- Retired: `warnAboutFutureAppliedMigrations` is live (`migrateWithFolders` calls it)
  but only warns about timestamps and gives no downgrade protection; the plan's "no new
  CLI flag" conflict with the CLI rule was resolved by adding
  `bb db restore-migration-backup`; the T-E1 timing flake in
  `test/data/transfer-operations.test.ts` is load-sensitive, not a runner
  defect.
- Divergences from the legacy chain: the legacy runner refuses unpopulated
  prefixes 1 to 14 and the namespaced runner migrates them; they also differ
  on S3 rows 18 to 21 (the D14 and D15 fixtures), which the namespaced runner
  refuses by name (`MigrationStateUnknown`). `migrateWithFolders` is an
  internal seam for tests.
- keepAwake skips the backup.
- Cost: the backup copy, check and count are about four passes over the file,
  and per-step digest checks run inside the migrating lock; the backup content
  and sequence digest finalization also runs under the lock (phase
  `finalizing`, see "Migration-safe update"). On a real
  5.5 GB database, 144 to 152 took about 250 s including the verified 5.0 GB
  backup, with integrity, foreign keys, FTS and row counts intact.
- Step 6 rollout tests: there is no crash hook before the backup or between
  COMMIT and finalize, so two D10 windows are untested. Lock wait is not
  observable without an engine hook; the race test shows both children reached
  migrate and stayed alive while the lock was held. `thread_pruning_cursors` is
  excluded from the D9 connection. The D14 and D15 row names are mapped in the
  describe title.
- Tier 2 schema note: on the real database the migrated result differs from
  the legacy chain's only by `__bb_migration_ledger`. `deferred_thread_messages_legacy`
  is created by migration 0111 and was absent from the real database before and
  after both runs, because the server drops it only once every row is delivered (`kept === 0`)
  (`apps/server/src/services/threads/legacy-deferred-messages.ts`, `DROP TABLE`
  after delivery); fresh installs and synthetic fixtures have it because the
  server has not started on them. The pre-migration `sqlite_master` row query
  was not captured before the copies were deleted, so this is the source-based
  explanation, not a recorded observation.
- Tier 3 is open: the real 0.7.0 binary check and a copy of the real database
  at state 152 after the 0.7.0 install.

Downgrade contract. The rollback window is 0.7.0 only, and only while the
database is still within the frozen chain (state 131 to 152); after a
genuinely new step it is unsupported, and the answer is to restore the
`.pre-ns-*` backup taken before the switch. The legacy runner does not enforce
this: the tests show it opens databases migrated by the namespaced runner at
131 through 152. Whether the real 0.7.0 binary does so is the Tier 3 check.
The release notes (step 8) carry the backup path, the restore steps and this
contract.

### Migration-safe update (mk-ooomf.1)

The 0.8.0 install lost its first start: the launcher's 60 s health deadline
expired while migrations on a 4.3 GB database took 181 to 220 s, the launcher
killed the server mid-migration, and systemd (`Restart=always`) started it
again to repeat the work. The update path now survives a migration of any
length up to a one-hour cap.

- The migrating lock releases its holder info file (`<db>.migrating.info`) when
  it is released, so the file exists only while a migration holds the lock. The
  helpers that read it (`readActiveMigration`, `isProcessAlive`,
  `MIGRATION_WAIT_CAP_MS`) live in `packages/config/src/migration-info.ts`
  (`@bb/config/migration-info`) because `bb-app` does not depend on `@bb/db`.
- `bb-app start` uses a sliding health deadline
  (`packages/bb-app/src/migration-wait.ts`). While the info file names a live
  process the deadline moves to now plus the 60 s timeout, so it expires 60 s
  after the migration ends or the server stops answering, never during the
  migration. The launcher logs `migrating database (phase X, N s elapsed)` every
  10 s. A migration older than the cap stops extending the deadline.
- `migrate()` keeps the lock and the info file through backup finalization
  (phase `finalizing`) and the history checks that follow, because finalization
  of a 5 GB backup took over a minute after the schema changes and would have
  run with no marker and no listening server.
- A stale info file is ignored, so a crashed migration does not extend the
  deadline. The info file records the holder's pid and, on Linux, its process
  identity (boot id plus start time from `/proc/<pid>/stat`).
  `readActiveMigration` rejects a marker whose pid is dead, whose recorded
  identity no longer matches the live process (pid reuse), or whose last update
  is older than the cap. The launcher also requires the marker's pid to equal
  the server process it spawned, which covers platforms without `/proc`.
- The server installs SIGTERM and SIGINT handlers before it opens the database
  (`apps/server/src/startup-stop-guard.ts`). A stop that arrives during a
  migration is recorded, the migration runs to completion, and the server exits
  cleanly before it starts listening. Without this the signal killed the
  migration even with a long `TimeoutStopSec`, because systemd sends SIGTERM to
  the whole control group first. Migrations are synchronous, so the handler
  runs once the migration yields.
- Stopping the launcher while a migration is active waits up to the cap for the
  server to finish instead of killing it after 5 s.
- The generated systemd unit (`install-machine.sh`) sets `TimeoutStopSec=3900`
  so systemd does not kill a migrating server on `stop` or `restart`.
- Existing installed units predate `TimeoutStopSec`. Add a drop-in once per
  host: `[Service]` with `TimeoutStopSec=3900` in
  `~/.config/systemd/user/<unit>.service.d/migration-stop.conf`, then
  `systemctl --user daemon-reload`.
- Evidence: unit tests drive a virtual clock through a 250 s migration against a
  real HTTP server. The rehearsal ran the real launcher and the real `migrate()`
  (204 s, then padded to 250 s) on a copy of the pre-namespace 5.3 GB database
  under a transient `Restart=always` systemd unit with the 60 s timeout
  unchanged: healthy after 250.8 s, zero unit restarts. A control with the
  marker hidden from the launcher failed at 60 s, and a run before the
  finalization fix failed 60 s after the lock was released. A second rehearsal
  ran `systemctl --user stop` (`TimeoutStopSec=3900`) 65 s into the real
  migration: the server logged the deferred stop, finished the migration
  (203 s), exited 0 with no restart and no leftover info file, and the next
  start found nothing to migrate (15 ms). The 250 s rehearsal also passed with
  the stricter marker checks.

## Project documents

- [Mission](MISSION.md): make long-running, multi-provider coordinator
  sessions spend their usage on project progress.
- [Philosophy](PHILOSOPHY.md): principles for spending usage well, and for
  keeping the fork thin and current.
- [Vision](docs/aleph-vision.md): where usage is lost today, where Aleph is
  going, and how it relates to upstream bb.
- [Personas](docs/aleph-personas.md): coordinator agents, the operator, and
  worker or reviewer agents.
- [Critical user journeys](docs/cujs/README.md)
- [Roadmap](docs/aleph-roadmap.md) and [backlog](docs/aleph-backlog.md)
