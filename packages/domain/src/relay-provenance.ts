import { z } from "zod";

export const relayProvenanceSchema = z
  .object({
    relayMessageId: z.string().min(1),
    hostId: z.string().min(1),
    hostName: z.string().min(1),
    clientMessageId: z.string().min(1),
    label: z.string().min(1).nullable(),
  })
  .strict();
export type RelayProvenance = z.infer<typeof relayProvenanceSchema>;

export const relayMessageStatusValues = [
  "reserved",
  "cleaning",
  "accepted",
  "failed",
  "cancelled",
] as const;
export type RelayMessageStatus = (typeof relayMessageStatusValues)[number];

export const connectBindingRuntimeValues = ["production", "staging"] as const;
export type ConnectBindingRuntime =
  (typeof connectBindingRuntimeValues)[number];
