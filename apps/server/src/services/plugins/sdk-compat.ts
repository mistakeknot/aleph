import semver from "semver";
import { PLUGIN_SDK_VERSION } from "@bb/domain";

export function isPluginSdkRangeSatisfied(
  range: string,
  runningVersion: string = PLUGIN_SDK_VERSION,
): boolean {
  if (semver.validRange(range) === null) return false;
  if (semver.satisfies(runningVersion, range)) return true;
  const floor = semver.minVersion(range);
  if (floor === null) return false;
  if (semver.major(floor) !== semver.major(runningVersion)) return false;
  return semver.gte(runningVersion, floor);
}

export function pluginSdkRangeProblem(range: string): string {
  return `requires bb plugin SDK ${range}, running SDK is ${PLUGIN_SDK_VERSION}`;
}
