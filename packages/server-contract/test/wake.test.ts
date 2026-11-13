import { describe, expect, it } from "vitest";
import {
  createThreadRequestSchema,
  forkThreadRequestSchema,
  sendMessageRequestSchema,
  createQueuedMessageRequestSchema,
  editMessageRequestSchema,
  updateQueuedMessageRequestSchema,
} from "../src/api/threads.js";

const input = [{ type: "text", text: "hello" }];
const boundaries = [
  { schema: sendMessageRequestSchema, base: { input, mode: "auto" } },
  { schema: createQueuedMessageRequestSchema, base: { input } },
  { schema: forkThreadRequestSchema, base: { sourceThreadId: "source" } },
  {
    schema: createThreadRequestSchema,
    base: {
      projectId: "project",
      origin: "sdk",
      input,
      environment: {
        type: "host",
        hostId: "host",
        workspace: { type: "unmanaged", path: null },
      },
    },
  },
];

describe("wake admission contracts", () => {
  it.each(boundaries)(
    "accepts legacy and attributed inputs",
    ({ schema, base }) => {
      expect(schema.safeParse(base).success).toBe(true);
      expect(
        schema.parse({
          ...base,
          wakeCause: "card_pick",
          wakeRef: "operation-1",
        }),
      ).toMatchObject({ wakeCause: "card_pick", wakeRef: "operation-1" });
    },
  );
  it.each(boundaries)(
    "rejects invalid new causes and oversized UTF-16 refs",
    ({ schema, base }) => {
      for (const wakeCause of ["future", null, 1])
        expect(schema.safeParse({ ...base, wakeCause }).success).toBe(false);
      expect(
        schema.safeParse({ ...base, wakeRef: "😀".repeat(101) }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...base, wakeRef: "😀".repeat(100) }).success,
      ).toBe(true);
    },
  );
  it("rejects attribution edits even alongside a valid change", () => {
    for (const attribution of [
      { wakeCause: "message" },
      { wakeRef: "replacement" },
    ]) {
      expect(
        editMessageRequestSchema.safeParse({
          input,
          operationId: "edit",
          ...attribution,
        }).success,
      ).toBe(false);
      expect(
        updateQueuedMessageRequestSchema.safeParse({
          input,
          expectedUpdatedAt: 1,
          ...attribution,
        }).success,
      ).toBe(false);
    }
  });
});
