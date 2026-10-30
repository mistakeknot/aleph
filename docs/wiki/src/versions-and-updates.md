# Versions and updates

An Aleph version has the form `<upstream>+aleph.<X.Y.Z>`. The current package
version is <!--fig:package-version=0.48.0+aleph.0.9.0-->0.48.0+aleph.0.9.0.

Semver ignores build metadata, so <!--fig:upstream-version=0.48.0-->`0.48.0` compares equal to
<!--fig:package-version=0.48.0+aleph.0.9.0-->`0.48.0+aleph.0.9.0` and the next upstream patch release would compare newer. Aleph builds

therefore never offer an upstream release: `isAlephAppVersion` in
`packages/config/src/aleph-version.ts` detects `aleph` in the build metadata
and turns upstream update checks off.

`node scripts/bump-version.mjs` orders Aleph releases by the Aleph part. It
takes `--patch`, `--minor` or `--major`, or an explicit version, and refuses
an older Aleph release, an older upstream base, or a version without
`+aleph.<release>`. The release is normally `X.Y.Z`; the legacy form
`+aleph.<n>` is still accepted and counts as release `X.Y.Z` with X and Z zero and Y set to `n`.

The signed update channel and its planned stages are in
`FORK.md` and [the roadmap](journeys-and-roadmap.md).
