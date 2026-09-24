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
  compares newer. bb's npm update check and the desktop update check therefore
  offer upstream 0.43.5 as an update, and installing it replaces Aleph.
- `0.43.4+aleph.2` does not compare newer than `0.43.4+aleph.1`. Update checks
  do not offer it, and `scripts/bump-version.mjs` refuses it. Set both
  `packages/bb-app/package.json` and `apps/desktop/package.json` directly;
  `.github/workflows/check-version-lockstep.mjs` checks that they match.
- `npm pack` keeps the metadata in the tarball name, for example
  `bb-app-0.43.4+aleph.1.tgz`. The npm registry drops build metadata, so an
  Aleph version cannot be published under the upstream `bb-app` package name.

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
- **Release qualification.** `scripts/ci-zklw-release-check.sh`, run by the
  zklw fleet worker in a credential-free guest.

`git log --no-merges <upstream main>..HEAD` lists the carried commits.
Upstream is merged into Aleph, not rebased, and each merge commit records its
conflicts.

## Project documents

- [Mission](MISSION.md): why Aleph exists.
- [Philosophy](PHILOSOPHY.md): how the fork is kept thin and current.
- [Vision](docs/aleph-vision.md): where Aleph is going and how it relates to
  upstream bb.
- [Personas](docs/personas.md): the operator, coordinator agents and worker
  or reviewer agents.
- [Critical user journeys](docs/cujs/README.md)
- [Roadmap](docs/aleph-roadmap.md) and [backlog](docs/backlog.md)
