# Aleph

Aleph is a fork of [bb](https://github.com/get-bb/bb), an agentic IDE for
running coding-agent threads across machines and providers. It is built for
long-running coordinator sessions: a coordinator thread runs a project for
days, starts child threads for implementation and review, and hands decisions
to a human operator.

Aleph's [mission](MISSION.md) is to make those sessions spend their usage on
project progress. Across several providers and the operator's own accounts,
every token should buy output or quality, and none should be lost to wake
storms, stuck waits, unbounded reviews or jobs dying on a refusal nobody
planned for.

The name comes from the Aleph in William Gibson's _Mona Lisa Overdrive_ and
from Jorge Luis Borges' story "The Aleph" ([FORK.md](FORK.md)).

> [!NOTE]
> Aleph follows upstream bb instead of competing with it, and distributing
> Aleph is a [non-goal](docs/aleph-vision.md#not-goals) today. This repository
> publishes no release artifacts, installers or downloads; you build Aleph from
> source. Most of the [roadmap](docs/roadmap.md) is goals, not shipped features.

## What Aleph adds over bb

Shipped today, from [FORK.md](FORK.md#carried-patches):

- **Account Pooler.** Thread availability bound to the thread's owning
  machine; `bb pool exec` for Codex and Claude, so scripted runs draw on a pool
  of your own accounts, within a budget; and attempt receipts for budgeted
  dispatch. The contract is
  [`plugins/account-pool/RECEIPTS.md`](plugins/account-pool/RECEIPTS.md). A
  header chip and `bb pool burn` show how fast the pool is burning quota.
- **No upstream update offers.** Aleph builds never offer, download or install
  an upstream bb release ([Updates](FORK.md#updates)). Updating Aleph follows a
  signed update channel, or a newer Aleph build installed by hand
  ([Signed update channel](FORK.md#signed-update-channel)).
- **Migration-safe restarts.** The server defers a stop signal until its
  database migration finishes ([Migration-safe update](FORK.md#migration-safe-update-mk-ooomf1)).
- **Agent process priority.** Host plugin workers and terminal PTYs run at a
  lower priority (`BB_AGENT_NICE`), so agent workloads cannot starve the server.
- **Extra workspace-write roots.** `BB_EXTRA_WORKSPACE_WRITE_ROOTS` lets
  workspace-write threads write to directories such as a shared build cache.
- **Composer-stuck fixes and a renderer diagnostics log** for the desktop app.
- **Model picker.** Switching a thread's provider in place when the local
  handoff plugin is running.
- **Thread list and panes.** Provider icons in the thread list; optional
  composer focus when switching split panes by keyboard.
- **Themes.** Thecla, the default for new installs, and Dorcas, for OLED
  screens.
- **Release qualification** in the fork's own CI
  (`scripts/ci-release-check.sh`).

The [changelog](CHANGELOG.md) covers each Aleph release.

Not built yet: DONE/BLOCKED as a structural rule, capped returns, outcome waits
with deadlines, bounded review, checkpoints for coordinator rotation, capacity
forecasts, and any measure of usage per outcome. See the
[vision](docs/aleph-vision.md), [roadmap](docs/roadmap.md) and
[philosophy](PHILOSOPHY.md).

## How Aleph relates to upstream bb

Aleph keeps bb's package names (`bb-app`, `@bb/desktop`, plugin packages) and
command names (`bb`, `bb-app`), so upstream merges stay clean and bb's
documentation still applies. Upstream's direction wins: when upstream ships its
own answer to a problem Aleph patched, Aleph adopts it and drops the patch.

- **Version.** The package version keeps the upstream bb release Aleph is based
  on and carries the Aleph version as build metadata. The current version is
  `0.48.0+aleph.0.9.0`: Aleph 0.9.0 on upstream bb 0.48.0. See
  [Versions](FORK.md#versions).
- **Tracking.** [`UPSTREAM_BASE`](UPSTREAM_BASE) records the upstream commit,
  the upstream release and the Aleph version of the last sync. Upstream is
  merged into Aleph, not rebased, and upstream syncs land as real merge commits
  that record the upstream commit as a second parent, so `git merge-base`
  against upstream shows the true shared history. Earlier syncs were squashed
  into single commits; one merge commit joined that history to upstream
  0.48.0. `scripts/upstream-sync.sh` probes how far upstream merges cleanly and
  prepares a sync branch ([Upstream syncs in small steps](FORK.md#upstream-syncs-in-small-steps)).
- **Carried differences.** The [patch ledger](docs/aleph-patch-ledger.md) lists
  every difference from upstream and how each is held, and is the checklist
  for a sync. `git log --no-merges <upstream main>..HEAD` lists the carried
  commits.
- **Contributions.** Aleph follows upstream's conventions for patches,
  including CLI parity and the plugin API rules in [AGENTS.md](AGENTS.md), so
  patches stay upstreamable. Success is a shorter diff against upstream, not a
  longer feature list.

## Building and running

Aleph is built from this repository. It needs Node.js 22.19 or later (see
`.nvmrc`) and pnpm 9.15.0. To run a production-mode build from a source
checkout:

```bash
pnpm install --frozen-lockfile
pnpm start
```

`pnpm start` builds the app, server and host-daemon runtime artifacts, then runs
the launcher. A production run serves on `http://localhost:38886` by default.
Aleph uses the provider CLIs you already have installed and authenticated;
provider setup and configuration are the same as bb's. See
[`packages/bb-app`](./packages/bb-app/README.md) and
[Configuration](docs/configuration.md).

Other ways to run it:

- **Server from a package.** Install `bb-app` from an `npm pack` of this
  checkout. The npm registry drops build metadata, so an Aleph version cannot
  be published under upstream's `bb-app` package, and `npx bb-app@latest`
  installs upstream bb, not Aleph ([Updates](FORK.md#updates)).
- **macOS desktop app.** Build it from source; the steps are in
  [Build the macOS desktop app](FORK.md#build-the-macos-desktop-app).
- **Other machines.** Enrolled machines running a launchd or systemd daemon do
  not follow the server automatically; see [Updates](FORK.md#updates).

Platform support is described in [Platform support](docs/platform-support.md).

### Telemetry

Production runs send anonymous usage telemetry, inherited from upstream. Opt
out with `BB_TELEMETRY=false`. Development runs (`pnpm dev`,
`pnpm start:worktree`) never send. See
[`apps/server/src/services/system/telemetry.ts`](./apps/server/src/services/system/telemetry.ts).

## Development

```bash
pnpm dev
```

This starts the Vite app and proxies API and WebSocket traffic to a separate
dev server. The launcher prints the actual ports at startup. Each checkout gets
a data directory under `~/.bb-dev/<checkout-instance>/` and deterministic high
ports derived from the checkout path, so separate worktrees can run alongside
each other.

To test the production bundle and serving path with checkout-specific data and
ports, use `pnpm start:worktree`. It has no hot reload; rerun it after source
changes.

The app hot reloads itself. The server and host daemon do not; rebuild and
restart them with:

```bash
pnpm dev:restart
pnpm dev:restart-server
pnpm dev:restart-host-daemon
```

Build and check with Turbo:

```bash
pnpm build
pnpm typecheck
pnpm test
```

Command-line access and state reset:

```bash
pnpm bb --help            # built CLI, targets the default/prod instance
pnpm reset                # clear production state

pnpm bb:dev --help        # source CLI, targets this checkout's dev instance
pnpm reset:dev            # clear this checkout's dev state

pnpm reset:all            # clear both production and dev states
```

The reset commands prompt for confirmation before deleting anything.

`pnpm dev:remote`, `pnpm start:worktree-remote` and `pnpm storybook` bind to
all interfaces. The server API is unauthenticated and permits command execution
and file reads, so use them only behind a trusted network boundary.

Aleph-specific tooling: `node scripts/bump-version.mjs --patch|--minor` bumps
the Aleph version ([Versions](FORK.md#versions)).

For the rest of the development workflow, see [AGENTS.md](AGENTS.md) and
[Worktrees and setup scripts](docs/worktrees.md).

## Documentation

Aleph:

- [Mission](MISSION.md), [philosophy](PHILOSOPHY.md), [vision](docs/aleph-vision.md)
- [Personas](docs/aleph-personas.md) and [critical user journeys](docs/cujs/README.md)
- [Roadmap](docs/roadmap.md) and [backlog](docs/aleph-backlog.md)
- [FORK.md](FORK.md): versions, updates, carried patches, upstream syncs, migrations
- [Patch ledger](docs/aleph-patch-ledger.md)
- [Changelog](CHANGELOG.md)

Inherited from bb:

- [Repository overview](docs/repository-overview.md)
- [System overview](docs/system-overview.md)
- [bb vision](docs/VISION.md)
- [Platform support](docs/platform-support.md)
- [Configuration](docs/configuration.md)
- [Using bb on multiple devices](docs/multiple-devices.md)

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) is upstream bb's guide, and its approval
process refers to bb's community, so it does not fully describe this
repository. Follow upstream's conventions for patches, and read
[AGENTS.md](AGENTS.md). Report security issues as described in
[SECURITY.md](SECURITY.md).

## Troubleshooting

### `Could not locate the bindings file`

bb's code, and therefore Aleph, uses native add-ons such as `better-sqlite3`,
`node-pty` and `@parcel/watcher`. If dependency install scripts did not run,
the binaries are absent and the server stops at startup with this error. Causes
include npm 12 or later blocking install scripts by default,
`ignore-scripts=true` in `~/.npmrc`, a Node.js major-version change after
install, and a `node_modules` copied from a different operating system,
architecture or libc. Reinstall with scripts allowed, or run
`npm rebuild better-sqlite3`.

## Acknowledgements

Aleph is built on [bb](https://github.com/get-bb/bb) by the bb maintainers and
contributors; most of the code is theirs. Aleph merges upstream into the fork
and follows upstream's direction
([vision](docs/aleph-vision.md#relationship-to-upstream-bb)). Both are
released under the [MIT license](LICENSE).
