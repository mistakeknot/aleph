import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
export const contextSchema = z
  .object({
    file: z.string().min(1),
    target: z.string().min(1),
    agentHome: z.string().min(1),
    sourceRoot: z.string(),
    builtinRoot: z.string(),
  })
  .strict();
const resultSchema = z.object({
  changes: z.array(
    z.object({
      section: z.string(),
      entry: z.string(),
      kind: z.enum(["added", "removed", "changed"]),
    }),
  ),
  unsupported: z.array(z.string()),
});
export const rigRpcContract = defineRpcContract({
  diff: { input: contextSchema, output: resultSchema },
  export: {
    input: contextSchema.extend({ output: z.string().min(1) }),
    output: z.object({ notices: z.array(z.string()) }),
  },
  plan: {
    input: contextSchema,
    output: resultSchema.extend({ confirmation: z.string() }),
  },
  apply: {
    input: contextSchema.extend({ confirmation: z.string().min(1) }),
    output: resultSchema,
  },
});
