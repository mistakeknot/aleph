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
  for Codex and Claude, with an argument allowlist, the pooled-transport marker
  and a host-private stdin directory; and attempt receipts for budgeted
  dispatch. Its contract is `plugins/account-pool/RECEIPTS.md`.
- **Thread list.** Provider icons with brand, monochrome, theme or custom
  colors.
- **Split panes.** Optional composer focus when switching panes with the
  keyboard.
- **Model picker.** Switching a thread's provider in place when the local
  handoff plugin is running.
- **No upstream update offers.** See [Updates](#updates).
- **Release qualification.** `scripts/ci-zklw-release-check.sh`, run by the
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
