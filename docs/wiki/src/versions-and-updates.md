# Versions and updates

An Aleph version has the form `<upstream>+aleph.<X.Y.Z>`. The current package
version is <!--fig:package-version=0.43.4+aleph.0.4.1-->0.43.4+aleph.0.4.1.

Semver ignores build metadata, so `0.43.4` compares equal to
`0.43.4+aleph.0.4.1` and upstream `0.43.5` would compare newer. Aleph builds
therefore never offer an upstream release: `isAlephAppVersion` in
`packages/config/src/aleph-version.ts` detects `aleph` in the build metadata
and turns upstream update checks off.

`node scripts/bump-version.mjs` orders Aleph releases by the Aleph part. It
takes `--patch`, `--minor` or `--major`, or an explicit version, and refuses
an older Aleph release, an older upstream base, or a version without
`+aleph.<release>`. The release is normally `X.Y.Z`; the legacy form
`+aleph.<n>` is still accepted and counts as `0.n.0`.

The signed update channel and its planned stages are in
`FORK.md` and [the roadmap](journeys-and-roadmap.md).
