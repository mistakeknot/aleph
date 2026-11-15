import { z } from "zod";

export const threadRoleStateSchema = z
  .object({
    role: z.string(),
    threadId: z.string().nullable(),
    title: z.string().nullable(),
    archived: z.boolean().nullable(),
    generation: z.number().int().nonnegative(),
    since: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type ThreadRoleStateResponse = z.infer<typeof threadRoleStateSchema>;

export const threadRoleListResponseSchema = z
  .object({ roles: z.array(threadRoleStateSchema) })
  .strict();
export type ThreadRoleListResponse = z.infer<
  typeof threadRoleListResponseSchema
>;

export const threadRoleConflictDetailsSchema = z
  .object({ current: threadRoleStateSchema })
  .strict();
export type ThreadRoleConflictDetails = z.infer<
  typeof threadRoleConflictDetailsSchema
>;

export const claimThreadRoleRequestSchema = z
  .object({ threadId: z.string().min(1) })
  .strict();
export type ClaimThreadRoleRequest = z.infer<
  typeof claimThreadRoleRequestSchema
>;

export const transferThreadRoleRequestSchema = z
  .object({
    toThreadId: z.string().min(1),
    expectGeneration: z.number().int().nonnegative().safe(),
  })
  .strict();
export type TransferThreadRoleRequest = z.infer<
  typeof transferThreadRoleRequestSchema
>;

export const releaseThreadRoleRequestSchema = z
  .object({ expectGeneration: z.number().int().nonnegative().safe() })
  .strict();
export type ReleaseThreadRoleRequest = z.infer<
  typeof releaseThreadRoleRequestSchema
>;
