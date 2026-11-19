import {
  computeThreadTimelineDelta,
  type ThreadTimelineReadResponse,
  type ThreadTimelineResponse,
} from "@bb/server-contract";
import { timelineRowHash } from "./timeline-window-tag.js";

// Design choice: bound delta preparation to one million JSON units.
const MAX_DELTA_WORK = 1_000_000;
const WORK_LIMIT = Symbol("timeline delta work limit");

export function selectThreadTimelineResponse(
  previous: ThreadTimelineResponse,
  current: ThreadTimelineResponse,
): ThreadTimelineReadResponse {
  let work = 0;
  const account = (_key: string, value: unknown): unknown => {
    work += typeof value === "string" ? value.length + 1 : 1;
    if (work > MAX_DELTA_WORK) {
      throw WORK_LIMIT;
    }
    return value;
  };
  try {
    const full = JSON.stringify(current, account);
    JSON.stringify(previous, account);
    const delta = computeThreadTimelineDelta(
      previous,
      current,
      timelineRowHash,
    );
    return Buffer.byteLength(JSON.stringify(delta), "utf8") <
      Buffer.byteLength(full, "utf8")
      ? delta
      : current;
  } catch (error) {
    if (error !== WORK_LIMIT) {
      throw error;
    }
    return current;
  }
}
