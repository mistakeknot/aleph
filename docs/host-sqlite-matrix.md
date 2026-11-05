# Host SQLite installed-artifact matrix

The enrolled host package depends on `better-sqlite3` at the same exact version as `bb-app` (13.0.3). The module stays external to the host daemon bundle, so the installed package must provide a working binding with FTS5. The host daemon probes this at startup and disables session-search indexing when the probe fails.

## How a row is produced

`node packages/bb-app/scripts/verify-host-sqlite.mjs` (after `pnpm --filter bb-app build:host`) packs `packages/bb-app/host-package`, installs the tarball with `npm install --omit=dev` into an empty directory under the OS temp directory, and runs the probe through the installed package's own module resolution. The probe checks `sqlite_version()`, `octet_length` on a multibyte string, and an FTS5 create, insert, match and delete. A row passes only when the binding resolved outside the workspace.

## Results

| Platform     | Arch  | Node ABI | Status  | SQLite  |
| ------------ | ----- | -------- | ------- | ------- |
| linux        | x64   | 127      | pass    | 3.53.4  |
| linux        | arm64 | not-run  | not-run | not-run |
| linux (musl) | x64   | not-run  | not-run | not-run |
| linux (musl) | arm64 | not-run  | not-run | not-run |
| darwin       | arm64 | not-run  | not-run | not-run |
| darwin       | x64   | not-run  | not-run | not-run |
| win32        | x64   | not-run  | not-run | not-run |
| win32        | arm64 | not-run  | not-run | not-run |

A `not-run` row has no evidence and does not count as passed. The linux x64 row was run on Node v22.23.4. Other Node ABIs were not run either.
