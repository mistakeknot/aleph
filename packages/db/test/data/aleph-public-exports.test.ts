import { describe, expect, it } from "vitest";
import * as db from "../../src/index.js";
import * as lifecycle from "../../src/internal-environment-lifecycle.js";

describe("Aleph database export boundaries", () => {
  it("retains fork entry points", () => {
    for (const name of [
      "claimThreadRole",
      "getStoredAlephInstallRequest",
      "recordThreadSearchSelection",
      "reserveIdempotentThreadOperation",
      "retireQueuedThreadMessages",
      "assertThreadEventsNotCold",
      "getDatabaseMaintenanceActivity",
      "COMPLETED_EVENT_OUTPUT_RETENTION_MS",
      "RETAINED_EVENT_OUTPUT_TARGETS",
    ]) {
      expect(db).toHaveProperty(name);
    }
  });

  it("keeps internal lifecycle writers and fork helpers off the root", () => {
    for (const name of [
      "applyEnvironmentLifecycleEvent",
      "applyEnvironmentLifecycleEventInTransaction",
      "recordProvisionedEnvironmentWorkspace",
      "getLastQueuedThreadMessage",
      "claimQueuedThreadMessageIdsInTransaction",
      "sweepStaleQueuedMessageClaims",
      "countQueuedThreadMessagesInTransaction",
      "isThreadMaintenanceBusy",
    ]) {
      expect(db).not.toHaveProperty(name);
    }
    expect(lifecycle.applyEnvironmentLifecycleEvent).toBeTypeOf("function");
    expect(lifecycle.applyEnvironmentLifecycleEventInTransaction).toBeTypeOf(
      "function",
    );
    expect(lifecycle.recordProvisionedEnvironmentWorkspace).toBeTypeOf(
      "function",
    );
  });
});
