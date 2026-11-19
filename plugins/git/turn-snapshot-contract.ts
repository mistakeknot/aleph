import { z } from "zod";

// Design choice: bound inventory work to 20,000 paths per snapshot.
export const TURN_SNAPSHOT_MAX_FILES = 20_000;
// Design choice: bound captured file content to 64 MiB per snapshot.
export const TURN_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
// Design choice: allow two seconds of wall time for each snapshot or diff read.
export const TURN_SNAPSHOT_MAX_MS = 2_000;
// Design choice: never return a patch larger than 2 MiB as complete.
export const TURN_SNAPSHOT_MAX_PATCH_BYTES = 2 * 1024 * 1024;
// Design choice: retain at most ten turn pairs per thread.
export const TURN_SNAPSHOT_KEEP_TURNS = 10;

export const TURN_SNAPSHOT_DIFF_LABEL =
  "Interval diff: worktree changes during the turn, not proof of agent authorship.";

export const turnSnapshotDiffSchema = z
  .object({
    status: z.enum(["captured", "incomplete", "not-captured"]),
    reason: z.string().nullable(),
    label: z.literal(TURN_SNAPSHOT_DIFF_LABEL),
    names: z
      .array(
        z.object({
          status: z.enum(["A", "M", "D", "R", "C", "T"]),
          path: z.string(),
          previousPath: z.string().nullable(),
        }),
      )
      .max(TURN_SNAPSHOT_MAX_FILES * 2),
    patch: z
      .string()
      .refine(
        (patch) =>
          new TextEncoder().encode(patch).length <=
          TURN_SNAPSHOT_MAX_PATCH_BYTES,
        "patch byte cap",
      ),
  })
  .superRefine((result, context) => {
    if (
      result.status !== "captured" &&
      (result.patch !== "" || result.names.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "incomplete captures cannot expose partial diff data",
      });
    }
    if (result.status !== "captured" && !result.reason) {
      context.addIssue({
        code: "custom",
        message: "uncaptured intervals require a reason",
      });
    }
  });
export type TurnSnapshotDiff = z.infer<typeof turnSnapshotDiffSchema>;
