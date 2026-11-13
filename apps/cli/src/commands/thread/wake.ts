import { wakeCauseSchema, wakeRefSchema } from "@bb/domain";

export function parseWakeOptions(options: {
  wakeCause?: string;
  wakeRef?: string;
}) {
  return {
    wakeCause:
      options.wakeCause === undefined
        ? undefined
        : wakeCauseSchema.parse(options.wakeCause),
    wakeRef:
      options.wakeRef === undefined
        ? undefined
        : wakeRefSchema.parse(options.wakeRef),
  };
}
