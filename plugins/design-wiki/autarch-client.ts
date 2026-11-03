import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const AUTARCH_PLUGIN_ID = "autarch";

export const CARD_KEY_FOR_AUTARCH = /^[A-Z][A-Z0-9]{1,11}-\d{1,7}$/;

const cardStateResult = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }).passthrough(),
  z
    .object({ found: z.literal(true), state: z.string(), title: z.string() })
    .passthrough(),
]);

const askOptionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    approval: z.unknown().optional(),
  })
  .passthrough();

const owedAskSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    revision: z.string(),
    ask: z
      .object({
        kind: z.string(),
        question: z.string().optional(),
        recommendation: z.string().optional(),
        options: z.array(askOptionSchema).optional(),
        questions: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const listAsksResult = z.object({ owed: z.array(z.unknown()) }).passthrough();

const pickResult = z
  .object({
    ok: z.boolean(),
    status: z.number().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type AutarchCardState = z.infer<typeof cardStateResult>;
export type AutarchOwedAsk = z.infer<typeof owedAskSchema>;
export type AutarchPickResult = z.infer<typeof pickResult>;

export interface AutarchClient {
  cardState(key: string): Promise<AutarchCardState>;
  owed(): Promise<AutarchOwedAsk[]>;
  pick(input: {
    decisionId: string;
    optionId: string;
    revision: string;
    pickId: string;
  }): Promise<AutarchPickResult>;
}

type CallInput = Parameters<
  BbPluginApi["sdk"]["plugins"]["callRpc"]
>[0]["input"];

export function autarchClient(bb: BbPluginApi): AutarchClient {
  function call<Output>(
    method: string,
    outputSchema: z.ZodType<Output>,
    input: CallInput,
  ): Promise<Output> {
    return bb.sdk.plugins.callRpc({
      pluginId: AUTARCH_PLUGIN_ID,
      method,
      input,
      outputSchema,
    });
  }
  return {
    cardState(key) {
      return call("cardState", cardStateResult, { key });
    },
    async owed() {
      const result = await call("listAsks", listAsksResult, null);
      return result.owed.flatMap((entry) => {
        const parsed = owedAskSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
    },
    pick(input) {
      return call("pick", pickResult, {
        decision_id: input.decisionId,
        option_id: input.optionId,
        revision: input.revision,
        pick_id: input.pickId,
      });
    },
  };
}
