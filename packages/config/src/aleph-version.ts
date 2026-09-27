// No Node imports: the browser app reads this too.
export function isAlephAppVersion(version: string): boolean {
  const buildStart = version.indexOf("+");
  if (buildStart === -1) {
    return false;
  }
  return version
    .slice(buildStart + 1)
    .split(".")
    .some((identifier) => identifier.split("-").includes("aleph"));
}

export function alephReleaseVersion(version: string): string | null {
  const buildStart = version.indexOf("+");
  if (buildStart === -1) {
    return null;
  }
  const match = /^aleph\.(\d+\.\d+\.\d+)$/u.exec(version.slice(buildStart + 1));
  return match?.[1] ?? null;
}
