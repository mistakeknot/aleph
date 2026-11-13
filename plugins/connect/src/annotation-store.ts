import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  annotationScopeSchema,
  annotationChangeSchema,
  connectAnnotationSchema,
} from "@bb/connect-client/annotations/annotation-store";
export * from "@bb/connect-client/annotations/annotation-store";
export const annotationRpcContract = defineRpcContract({
  "connect.experimental_annotations.list": {
    input: annotationScopeSchema,
    output: z.array(connectAnnotationSchema),
  },
  "connect.experimental_annotations.change": {
    input: annotationScopeSchema.extend({ change: annotationChangeSchema }),
    output: z.array(connectAnnotationSchema),
  },
});
