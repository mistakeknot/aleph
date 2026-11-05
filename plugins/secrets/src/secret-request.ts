import { z } from "zod";

export const SECRET_REQUEST_RENDERER_ID = "secret-request";

const SECRET_VALUE_MAX_LENGTH = 16 * 1024;

export const secretNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .refine((name) => name !== "__proto__", {
    message: "Secret names must not be __proto__",
  });

export const secretRequestPayloadSchema = z
  .object({
    requestId: z.string().uuid(),
    threadId: z.string().min(1),
    project: z.string().min(1),
    purpose: z.string().min(1).nullable(),
    destination: z
      .object({
        kind: z.literal("dotenv"),
        path: z.string().min(1),
        consumer: z.string().min(1),
      })
      .strict(),
    digestPrefix: z.string().regex(/^[0-9a-f]{12}$/u),
    allowlistEntryPrefix: z.string().regex(/^[0-9a-f]{12}$/u),
    expiresAtMs: z.number().int().positive(),
    fields: z
      .array(
        z
          .object({
            name: secretNameSchema,
            description: z.string().min(1).nullable(),
            existing: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type SecretRequestPayload = z.infer<typeof secretRequestPayloadSchema>;

const secretValueSchema = z
  .string()
  .min(1)
  .max(SECRET_VALUE_MAX_LENGTH)
  .refine((value) => !value.includes("\n") && !value.includes("\r"), {
    message: "Secret values must be single-line strings",
  })
  .refine((value) => !value.includes("\0"), {
    message: "Secret values must not contain NUL",
  });

export const secretRequestResponseSchema = z
  .object({
    values: z.record(secretNameSchema, secretValueSchema),
  })
  .strict();
export type SecretRequestResponse = z.infer<typeof secretRequestResponseSchema>;
