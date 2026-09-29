import {
  clearConnectBinding,
  getConnectBinding,
  replaceConnectBinding,
  setConnectBindingReconciled,
} from "@bb/db";
import type { AppDeps } from "../../types.js";
import {
  RELAY_ASSERTION_ISSUERS,
  connectRuntimeForBaseUrl,
} from "./assertion-keys.js";
import { closeRelayFence, openRelayFence } from "./reconcile-fence.js";
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
  closeRelayFence(deps.db);
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
  return getConnectBinding(deps.db)?.reconciled === true;
}

export function markConnectRelayIdentityReconciled(
  deps: Pick<AppDeps, "db">,
  reconciled: boolean,
): boolean {
  closeRelayFence(deps.db);
  const exists = setConnectBindingReconciled(deps.db, reconciled);
  if (reconciled && exists) openRelayFence(deps.db);
  return exists;
}

export function closeConnectRelayFence(deps: Pick<AppDeps, "db">): void {
  closeRelayFence(deps.db);
}
