import { compareSemver } from "./semver.mjs";

const alephReleasePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const legacyAlephBuildPattern = /^(0|[1-9]\d*)$/u;

function splitBuildMetadata(version) {
  const buildStart = version.indexOf("+");

  return buildStart === -1
    ? { base: version, build: null }
    : { base: version.slice(0, buildStart), build: version.slice(buildStart + 1) };
}

export function parseAlephVersion(version) {
  const { base, build } = splitBuildMetadata(version);

  if (build === null || !build.startsWith("aleph.")) {
    return null;
  }

  const release = build.slice("aleph.".length);
  const releaseMatch = alephReleasePattern.exec(release);

  if (releaseMatch !== null) {
    const [, major, minor, patch] = releaseMatch;

    return {
      base,
      release: [BigInt(major), BigInt(minor), BigInt(patch)],
    };
  }

  if (legacyAlephBuildPattern.test(release)) {
    return { base, release: [0n, BigInt(release), 0n] };
  }

  throw new Error(
    `Invalid Aleph version ${version}: expected <upstream version>+aleph.<X.Y.Z>.`,
  );
}

export function formatAlephVersion({ base, release }) {
  return `${base}+aleph.${release.join(".")}`;
}

function compareReleases(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index] ? 1 : -1;
    }
  }

  return 0;
}

export function compareAlephVersions(leftVersion, rightVersion) {
  const left = parseAlephVersion(leftVersion);
  const right = parseAlephVersion(rightVersion);

  if (left === null || right === null) {
    throw new Error(
      `Cannot compare ${leftVersion} and ${rightVersion} as Aleph versions.`,
    );
  }

  const releaseComparison = compareReleases(left.release, right.release);

  return releaseComparison !== 0
    ? releaseComparison
    : compareSemver(left.base, right.base);
}

export function deriveAlephVersion(currentVersion, bumpType) {
  const current = parseAlephVersion(currentVersion);

  if (current === null) {
    throw new Error(`Not an Aleph version: ${currentVersion}`);
  }

  const [major, minor, patch] = current.release;
  const release =
    bumpType === "--major"
      ? [major + 1n, 0n, 0n]
      : bumpType === "--minor"
        ? [major, minor + 1n, 0n]
        : bumpType === "--patch"
          ? [major, minor, patch + 1n]
          : null;

  if (release === null) {
    throw new Error(`Unsupported bump flag: ${bumpType}`);
  }

  return formatAlephVersion({ base: current.base, release });
}

export function assertAlephVersionFollows({ currentVersion, newVersion }) {
  const current = parseAlephVersion(currentVersion);
  const next = parseAlephVersion(newVersion);

  if (current === null) {
    return;
  }

  if (next === null) {
    throw new Error(
      `New version ${newVersion} drops the +aleph.<X.Y.Z> build metadata of ${currentVersion}; without it an Aleph build offers upstream updates.`,
    );
  }

  if (compareReleases(next.release, current.release) <= 0) {
    throw new Error(
      `New Aleph version ${newVersion} must have a greater Aleph release than ${currentVersion}.`,
    );
  }

  if (compareSemver(next.base, current.base) < 0) {
    throw new Error(
      `New Aleph version ${newVersion} must not move to an older upstream base than ${currentVersion}.`,
    );
  }
}
