import { createHash } from "node:crypto";

export function producerWakeRef(id: string): string {
  return id.length <= 200
    ? id
    : `sha256:${createHash("sha256").update(id).digest("hex")}`;
}
