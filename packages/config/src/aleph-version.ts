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
