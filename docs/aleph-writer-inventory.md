# Aleph writer inventory and stock-bb coexistence

This is the R1b inventory (release plan §7.4, §8.2). It comes from reading the
source at the commit that introduced it. Facts that need a running stock bb are
marked UNKNOWN and are covered by the guest side-by-side run, which has not
happened yet.

## Data directory

Aleph uses `~/.aleph` (`ALEPH_DATA_DIR_NAME`). `BB_DATA_DIR` still overrides it.
Every launch path calls `runLaunchGuard` (`@bb/config/launch-guard`) before it
opens anything. The guard refuses, with `AlephDataDirRefusedError`, a data dir
that is:

- `inside_stock_bb_dir`: inside `~/.bb` or `~/Library/Application Support/bb`,
  after `realpath`;
- `stock_bb_database`: holding a `bb.db` whose migration journal lacks fork
  migrations 0132 and 0133, is empty, is missing, or cannot be read. An existing
  database fails closed; only a directory with no `bb.db` is accepted;
- `stock_bb_runtime_file`: holding a `bb-app-runtime.json` whose version is not
  an Aleph version. Stock bb writes this file in `packages/config/src/app-runtime-file.ts`.

The refusal does not depend on stock bb honoring Aleph's lock.

The launch version is derived from the running code: the `version` of the
enclosing `bb-app` package, or `0.0.0-dev` in a checkout. `BB_APP_VERSION` is
caller-controlled and is never the identity. A value that contradicts the code
version aborts the launch with exit code 1. Server and daemon run
`exitOnLaunchRefusal` before installing diagnostics, and a refusal writes only
to stderr: no `logs/` directory and no crash report appear in a stock or fenced
data directory.

The fence compares on one release identity, `alephReleaseIdentity`
(`@bb/config/aleph-version`): `0.44.0+aleph.0.5.0` and plain `0.5.0` both map to
`0.5.0`, and `0.0.0-dev` stays as it is. Server, daemon and CLI report the
`bb-app` package version and the desktop reports `app.getVersion()`; both reduce
to the same identity, on the process side and on the fence's `from_version` and
`to_version`.

## Existing data and merge lane

Changing the default to `~/.aleph` leaves data in `~/.bb` in place but
unavailable to Aleph until R19 migrates existing private data. R1b must not
merge to any private-candidate lane before R19.

## Required pre-release checks still outstanding

- The side-by-side run of stock bb and Aleph in Mac and Linux guests is owned by
  the Mac/Linux guest bead. It has not been run; nothing here claims its result.

## Writers of `~/.aleph`

| Writer                                   | Opens                                                                   | Guard                                                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop main process                     | no core DB; owns `update-state.json` and the fence advance              | `runLaunchGuard` role `desktop-main`, first statement of `runDesktopApp`                                                                                                 |
| Embedded server (`apps/server`)          | core `bb.db` via `createConnection`, plugin `data.db` files             | `runLaunchGuard` role `embedded-server`; `createConnection` backstop; `assertFenceAllowsDataDir` in `plugin-api.ts`, `plugin-state-snapshot.ts`, `server-move/export.ts` |
| Bundled host daemon (`apps/host-daemon`) | no DB; writes `host-id`, `auth.json`, `config.json`, `host-daemon-port` | `runLaunchGuard` role `bundled-daemon`                                                                                                                                   |
| `bb` CLI                                 | no direct DB writers; writes machine-enrollment files                   | `guardCliLaunch()` role `cli`, skipped for `--help` and `--version`                                                                                                      |
| Plugin workers                           | in-process through the server's plugin runtime                          | server-side guards above; the daemon plugin loader also applies `effectivePolicy()`                                                                                      |

`packages/config/test/fence-coverage.test.ts` scans `apps`, `packages`,
`plugins` and root `scripts` for `.ts`, `.tsx`, `.mjs`, `.cjs` and `.js` sources
outside test, generated and build-output directories. It fails when a scanned
source opens SQLite without a guard or an allowlist entry that carries a reason,
when an allowlist entry goes stale, or when a launch entry drops its guard or
runs it after diagnostics. It does not prove that no other open path exists, such
as a dynamic `import` of a database driver from an unscanned location. The
allowlist holds openers that never touch Aleph data (the desktop cookie and CDP
databases, the bb-app npm-revision store, the ACP
bridge, the desktop native-module smoke test) and the developer scripts (server benchmarks, perf seeding, migration
recording), which open through `createConnection` and its fence backstop.

## Fence and lock

- Lock: `acquireDataDirLock` takes a shared or exclusive OFD lock on
  `<dataDir>/.lock`. Holders are recorded in `.lock-holders`.
- Fence: `<dataDir>/maintenance.json`, with states `installing`, `probation` and
  `recovering`. Refusal exits with code 75.
- Effective policy: `effectivePolicy()` reads the DB row, the userData
  `aleph-update-state.json` and `<dataDir>/update-state.json`. The desktop app
  exports its userData directory as `ALEPH_USER_DATA_DIR` for the server and
  the daemon. Signature verification and pinned keys belong to R3. Until then
  the injected verifier is `failClosedPolicyVerifier`, and there is no
  `update_policy` table, so the DB copy reads as absent.
- External writers: `detectExternalWriters` (`@bb/config/external-writers`)
  probes candidate `bb` binaries and disables auto-update and auto-recovery when
  one predates Aleph 0.5.0 or cannot be probed. Auto-update itself lands in R3,
  which calls it at startup.

## Ports

| Purpose     | Stock bb (prod)                    | Aleph                                                 |
| ----------- | ---------------------------------- | ----------------------------------------------------- |
| Server      | 38886 (`BB_PROD_SERVER_PORT`)      | same default, so the two conflict on a shared machine |
| Host daemon | 38887 (`BB_PROD_HOST_DAEMON_PORT`) | same default                                          |

`reservePackagedAppPorts` maps dev instances that would land on those ports to
59000 and 59001. Whether Aleph should move its defaults is a decision for the
identity bead. Until then a second instance fails at bind time.

## Identifiers that still match stock bb

These come from the source and have not been observed on a guest:

- Electron `appId`: `dev.bb.desktop` (`apps/desktop/electron-builder.config.json`).
- The desktop code registers no custom URL scheme, so there is no LaunchServices
  handler to conflict on.
- Host-daemon services: LaunchAgent labels `app.getbb.host-daemon.*` and systemd
  units `bb-host-daemon-*`. A stock daemon and an Aleph daemon installed for the
  same data dir would collide; the labels embed the data dir.
- Safe Storage: the desktop uses Electron `safeStorage` for its own secrets. The
  Chromium-family "Safe Storage" keychain items in `browser-import/sources.ts`
  belong to other browsers and are read only.
- Stock PID or lock file: stock bb writes `bb-app-runtime.json`; it does not
  use a lock file (UNKNOWN for older releases).
