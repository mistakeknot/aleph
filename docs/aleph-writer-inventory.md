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
- `stock_bb_database`: holding a `bb.db` whose journal lacks fork migrations
  0132 and 0133;
- `stock_bb_runtime_file`: holding a `bb-app-runtime.json` whose version is not
  an Aleph version. Stock bb writes this file in `packages/config/src/app-runtime-file.ts`.

The refusal does not depend on stock bb honoring Aleph's lock.

## Writers of `~/.aleph`

| Writer | Opens | Guard |
|---|---|---|
| Desktop main process | no core DB; owns `update-state.json` and the fence advance | `runLaunchGuard` role `desktop-main`, first statement of `runDesktopApp` |
| Embedded server (`apps/server`) | core `bb.db` via `createConnection`, plugin `data.db` files | `runLaunchGuard` role `embedded-server`; `createConnection` backstop; `assertFenceAllowsDataDir` in `plugin-api.ts`, `plugin-state-snapshot.ts`, `server-move/export.ts` |
| Bundled host daemon (`apps/host-daemon`) | no DB; writes `host-id`, `auth.json`, `config.json`, `host-daemon-port` | `runLaunchGuard` role `bundled-daemon` |
| `bb` CLI | no direct DB writers; writes machine-enrollment files | `guardCliLaunch()` role `cli`, skipped for `--help` and `--version` |
| Plugin workers | in-process through the server's plugin runtime | server-side guards above; the daemon plugin loader also applies `effectivePolicy()` |

`packages/config/test/fence-coverage.test.ts` fails when a production source
opens a SQLite database without one of the guards, or when a launch entry drops
its guard. Its allowlist holds openers that never touch Aleph data: the desktop
cookie and CDP databases, the bb-app npm-revision store, the plugin-sdk fake
host and the ACP bridge.

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

| Purpose | Stock bb (prod) | Aleph |
|---|---|---|
| Server | 38886 (`BB_PROD_SERVER_PORT`) | same default, so the two conflict on a shared machine |
| Host daemon | 38887 (`BB_PROD_HOST_DAEMON_PORT`) | same default |

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
