# Aleph

Aleph is mk's fork of [bb](https://github.com/get-bb/bb), maintained at
`mistakeknot/bb`. The name comes from the Aleph in William Gibson's _Mona Lisa
Overdrive_ and from Jorge Luis Borges' story "The Aleph".

Aleph keeps bb's package names (`bb-app`, `@bb/desktop`, plugin packages) and
command names (`bb`, `bb-app`). Only the version and this file identify the
fork.

## Versions

Aleph versions are `<upstream version>+aleph.<n>`, for example
`0.43.4+aleph.1`: the upstream bb release Aleph is based on, then Aleph's build
number for that base. The changelog entry for each Aleph version names the
upstream main commit it includes.

`+aleph.<n>` is semver build metadata, and semver ignores build metadata when
comparing versions:

- Upstream `0.43.4` compares equal to `0.43.4+aleph.1`, and upstream `0.43.5`
  compares newer. Upstream's update checks would therefore offer 0.43.5, and
  installing it would replace Aleph. Aleph builds turn those checks off (see
  [Updates](#updates)).
- `0.43.4+aleph.2` does not compare newer than `0.43.4+aleph.1`, and
  `scripts/bump-version.mjs` refuses it. Set both
  `packages/bb-app/package.json` and `apps/desktop/package.json` directly;
  `.github/workflows/check-version-lockstep.mjs` checks that they match.
- `npm pack` keeps the metadata in the tarball name, for example
  `bb-app-0.43.4+aleph.1.tgz`. The npm registry drops build metadata, so an
  Aleph version cannot be published under the upstream `bb-app` package name.

## Updates

An Aleph build never offers an upstream release. `isAlephAppVersion` in
`packages/config/src/app-update.ts` matches the `+aleph.<n>` suffix, and when
it does:

- The server skips its npm lookup of `bb-app`, so Settings → Updates shows no
  upstream version and the in-app npm update has nothing to install.
- The desktop app turns off both its `desktop-latest` feed check and
  electron-updater, so it neither shows nor downloads an upstream release.

Updating Aleph means installing a newer Aleph build by hand: `bb-app` from
`npm pack` on the server, and a locally built desktop app on each Mac. Enrolled
machines that run the launchd or systemd daemon need nothing extra. Their
installer fetches the server's own `bb-app`, which is already Aleph.

### Build the macOS desktop app

A desktop app's local host daemon runs the `bb-app` bundled inside the app. A
Mac connected to an Aleph server therefore needs an Aleph desktop build at the
server's version. With stock bb, the server rejects the daemon for a
host-daemon protocol mismatch. On the Mac, at the server's commit:

```sh
# Node 22 (.nvmrc) and pnpm 9.15.0 (packageManager)
pnpm install --frozen-lockfile
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @bb/desktop run package
codesign --force --deep --sign - apps/desktop/release/mac-arm64/bb.app
```

Do not use `dist` or `desktop:build`; both pass `--publish always`. Before
installing, check that
`bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/package.json`
has the server's version. Then quit bb, move the old `/Applications/bb.app`
aside, copy the new one in, and run
`xattr -dr com.apple.quarantine /Applications/bb.app`. Enrollment lives in
`~/.bb`, outside the bundle, so it survives the swap.

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

`git log --no-merges <upstream main>..HEAD` lists the carried commits.
Upstream is merged into Aleph, not rebased, and each merge commit records its
conflicts.

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
