# Aleph

Aleph is mk's fork of [bb](https://github.com/get-bb/bb), an agentic IDE for
running coding-agent threads across machines and providers. Aleph is for
long-running coordinator sessions: a coordinator thread runs a project for
days, starts child threads for implementation and review, and hands decisions
to a human operator. Aleph's [mission](MISSION.md) is to make those sessions
spend their usage on project progress. Across several providers and many
accounts, every token should buy output or quality, and none should be lost to
wake storms, stuck waits, unbounded reviews or jobs dying on an exhausted
login.

The name comes from the Aleph in William Gibson's _Mona Lisa Overdrive_ and
from Jorge Luis Borges' story "The Aleph" ([FORK.md](FORK.md)).

> [!NOTE]
> Aleph is mk's fork, and it follows upstream bb instead of competing with it.
> Its [vision](docs/aleph-vision.md#not-goals) treats distributing Aleph as a
> non-goal today. A public release is planned, and publication needs mk's
> explicit approval; until that happens Aleph has not been published. Most of
> the [roadmap](docs/aleph-roadmap.md) is goals, not shipped features.

## What Aleph adds over bb

Shipped today, from [FORK.md](FORK.md#carried-patches):

- **Account Pooler 0.1.2.** Thread availability bound to the thread's owning
  machine; `bb pool exec` for Codex and Claude, so scripted runs draw on a pool of your own
  accounts, within a budget; and attempt receipts for budgeted dispatch. The
  contract is [`plugins/account-pool/RECEIPTS.md`](plugins/account-pool/RECEIPTS.md).
- **No upstream update offers.** Properly versioned Aleph release builds never
  offer, download or install an upstream bb release
  ([Updates](FORK.md#updates)).
- **Model picker.** Switching a thread's provider in place when the local
  handoff plugin is running.
- **Thread list.** Provider icons with brand, monochrome, theme or custom
  colors.
- **Split panes.** Optional composer focus when switching panes with the
  keyboard.
- **Thecla theme,** the default for new installs.
- **Release qualification** in the fork's own CI
  (`scripts/ci-zklw-release-check.sh`).

The [changelog](CHANGELOG.md) covers each Aleph release, including the desktop
app icon and Aleph version in the About panel, and Provider usage panel changes
in `0.43.4+aleph.0.4.1`.

Not built yet: DONE/BLOCKED as a structural rule, capped returns, outcome waits
with deadlines, bounded review, checkpoints for coordinator rotation, capacity
forecasts, and any measure of usage per outcome. See the
[vision](docs/aleph-vision.md), [roadmap](docs/aleph-roadmap.md) and
[philosophy](PHILOSOPHY.md).

## Names and versions

Aleph keeps bb's package names (`bb-app`, `@bb/desktop`, plugin packages) and
command names (`bb`, `bb-app`) so upstream merges stay clean and bb's
documentation still applies. Aleph's changes are the patches listed above, the
version, and the desktop app's name ("Aleph").

Aleph releases are named `aleph-X.Y.Z`, for example `aleph-0.4.1`. The package
version keeps the upstream bb release it is based on and carries the Aleph
version as build metadata: `0.43.4+aleph.0.4.1` is Aleph 0.4.1 on upstream bb
0.43.4. [FORK.md](FORK.md#versions) explains how versions are ordered and
bumped.

## Installing and running

Aleph has not been published yet; a public release is planned and needs
mk's approval. The npm registry drops build metadata, so an Aleph
version cannot be published under upstream's `bb-app` package, and
`npx bb-app@latest` and bb's desktop downloads install upstream bb, not Aleph.
Aleph is built from this repository ([FORK.md](FORK.md#updates)):

- **Server.** Install `bb-app` from an `npm pack` of this checkout, or run from
  source. A server started from a source checkout with `--in-app-updates` can
  fast-forward to this repository's `origin/main` from Settings → Updates.
- **macOS desktop app.** Build it from source; the steps are in
  [Build the macOS desktop app](FORK.md#build-the-macos-desktop-app).
- **Other machines.** Enrolled machines running a launchd or systemd daemon do
  not follow the server automatically; see
  [Updating Aleph](FORK.md#updates).

Building needs Node 22.19 or later and pnpm 9.15.0. To run a production-mode
build from a source checkout:

```bash
pnpm install --frozen-lockfile
pnpm start
```

Provider setup, configuration and requirements are the same as bb's; start with
[`packages/bb-app`](./packages/bb-app/README.md) and
[Configuration](docs/configuration.md). bb uses the provider CLI you already
have authenticated.

### Telemetry

Production runs send anonymous usage telemetry, inherited from upstream. Opt
out with `BB_TELEMETRY=false`. Development and source-checkout worktree runs
never send. See
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

For the rest of the development workflow, see [AGENTS.md](AGENTS.md) and
[Worktrees and setup scripts](docs/worktrees.md).

Aleph-specific tooling: `node scripts/bump-version.mjs --patch|--minor` bumps
the Aleph version ([FORK.md](FORK.md#versions)).

## Documentation

Aleph:

- [Mission](MISSION.md), [philosophy](PHILOSOPHY.md), [vision](docs/aleph-vision.md)
- [Personas](docs/aleph-personas.md), [critical user journeys](docs/cujs/README.md)
- [Roadmap](docs/aleph-roadmap.md) and [backlog](docs/aleph-backlog.md)
- [FORK.md](FORK.md): what the fork carries, versions, updates, migrations
- [Changelog](CHANGELOG.md)

Inherited from bb:

- [Repository overview](docs/repository-overview.md)
- [System overview](docs/system-overview.md)
- [bb vision](docs/VISION.md)
- [Platform support](docs/platform-support.md)
- [Configuration](docs/configuration.md)
- [Using bb on multiple devices](docs/multiple-devices.md)

## Contributing

Aleph is maintained by mk. [CONTRIBUTING.md](CONTRIBUTING.md) is upstream bb's
guide and its approval process refers to bb's community, so it does not describe
this repository. Follow upstream's conventions for patches, including CLI parity
and the plugin API rules in [AGENTS.md](AGENTS.md), so they stay upstreamable.

## Troubleshooting

### `Could not locate the bindings file`

bb uses native add-ons such as `better-sqlite3`, `node-pty` and
`@parcel/watcher`. If dependency install scripts did not run, the binaries are
absent and the server stops at startup with this error. Causes include npm 12 or
later blocking install scripts by default, `ignore-scripts=true` in `~/.npmrc`,
a Node.js major-version change after install, and a `node_modules` copied from a
different operating system, architecture or libc. Reinstall with scripts
allowed, or run `npm rebuild better-sqlite3`.

## Acknowledgements

Aleph is built on [bb](https://github.com/get-bb/bb) by the bb maintainers and
contributors; most of the code is theirs. Aleph merges upstream into the fork
and follows upstream's direction ([vision](docs/aleph-vision.md#relationship-to-upstream-bb)).
The [MIT license](LICENSE) is upstream's.
