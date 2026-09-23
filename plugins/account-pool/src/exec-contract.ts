import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const poolExecProviderSchema = z.enum(["claude", "codex"]);

export const poolExecHostContract = defineRpcContract({
  run: {
    input: z
      .object({
        provider: poolExecProviderSchema,
        command: z.string().min(1).max(4_096),
        args: z.array(z.string().max(65_536)).max(1_024),
        cwd: z.string().min(1).max(16_384).nullable(),
        token: z.string().min(1).max(65_536),
        baseUrl: z.url(),
      })
      .strict(),
    output: z
      .object({
        started: z.boolean(),
        exitCode: z.number().int().min(0).max(255),
        stdout: z.string(),
        stderr: z.string(),
      })
      .strict(),
  },
});
