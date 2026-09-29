import {
  clearConnectBinding,
  getConnectBinding,
  replaceConnectBinding,
} from "@bb/db";
import type { AppDeps } from "../../types.js";
import {
  RELAY_ASSERTION_ISSUERS,
  connectRuntimeForBaseUrl,
} from "./assertion-keys.js";
import { notifyRelayCancellation } from "./targets.js";

export interface ConnectRelayIdentityInput {
  baseUrl: string;
  ownerUserId: string;
  serverId: string;
}

export type ConnectRelayIdentityResult =
  | { status: "bound" | "unchanged" }
  | { status: "unsupported_runtime" };

export function bindConnectRelayIdentity(
  deps: {
    db: AppDeps["db"];
    hub: Pick<AppDeps["hub"], "notifyThread">;
  },
  input: ConnectRelayIdentityInput,
): ConnectRelayIdentityResult {
  const runtime = connectRuntimeForBaseUrl(input.baseUrl);
  const supported =
    runtime !== null && input.serverId !== "" && input.ownerUserId !== "";
  const result = !supported
    ? clearConnectBinding(deps.db)
    : replaceConnectBinding(deps.db, {
        runtime,
        issuer: RELAY_ASSERTION_ISSUERS[runtime],
        serverId: input.serverId,
        ownerUserId: input.ownerUserId,
      });
  for (const cancellation of result.cancellations) {
    notifyRelayCancellation(deps, cancellation);
  }
  if (!supported) return { status: "unsupported_runtime" };
  return { status: result.changed ? "bound" : "unchanged" };
}

export function hasConnectRelayIdentity(deps: Pick<AppDeps, "db">): boolean {
  return getConnectBinding(deps.db) !== null;
}
