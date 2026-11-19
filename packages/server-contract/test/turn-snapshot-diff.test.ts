import { expect, it } from "vitest";
import {
  TURN_SNAPSHOT_DIFF_LABEL,
  TURN_SNAPSHOT_MAX_PATCH_BYTES,
  turnSnapshotDiffSchema,
} from "../src/api/turn-snapshot-diff.js";

const empty = {
  reason: "not available",
  label: TURN_SNAPSHOT_DIFF_LABEL,
  names: [],
  patch: "",
};
it.each(["incomplete", "not-captured"])(
  "rejects a partial patch presented with %s status",
  (status) => {
    expect(turnSnapshotDiffSchema.safeParse({ ...empty, status }).success).toBe(
      true,
    );
    expect(
      turnSnapshotDiffSchema.safeParse({ ...empty, status, patch: "partial" })
        .success,
    ).toBe(false);
  },
);
it("enforces patch size in bytes rather than characters", () => {
  const patch = "界".repeat(Math.floor(TURN_SNAPSHOT_MAX_PATCH_BYTES / 2));
  expect(patch.length).toBeLessThan(TURN_SNAPSHOT_MAX_PATCH_BYTES);
  expect(
    turnSnapshotDiffSchema.safeParse({
      ...empty,
      status: "captured",
      reason: null,
      patch,
    }).success,
  ).toBe(false);
});
