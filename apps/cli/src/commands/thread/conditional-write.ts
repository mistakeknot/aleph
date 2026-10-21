import { BbHttpError } from "@bb/sdk";
import { z } from "zod";

const conflictStateSchema = z.object({
  details: z.object({
    current: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  }),
});

export function rethrowThreadConflict(error: unknown): never {
  if (
    error instanceof BbHttpError &&
    error.status === 409 &&
    error.code === "conflict"
  ) {
    const state = conflictStateSchema.safeParse(error.body);
    if (state.success)
      console.error(
        `Current state: ${JSON.stringify(state.data.details.current)}`,
      );
  }
  throw error;
}
