import { z } from "zod";

export const threadRoleNamePattern = /^[a-z0-9-]+$/;

export const threadRoleNameSchema = z
  .string()
  .regex(threadRoleNamePattern, "Role names match [a-z0-9-]+");
export type ThreadRoleName = z.infer<typeof threadRoleNameSchema>;

export const threadRoleUpdatedByKindValues = [
  "cli",
  "api",
  "app",
  "system",
] as const;
export const threadRoleUpdatedByKindSchema = z.enum(
  threadRoleUpdatedByKindValues,
);
export type ThreadRoleUpdatedByKind = z.infer<
  typeof threadRoleUpdatedByKindSchema
>;

export const threadRoleMaxGeneration = Number.MAX_SAFE_INTEGER;
