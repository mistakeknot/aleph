import {
  ConnectBindingConflictError,
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
import {
  closeRelayFence,
  isRelayFenceOpen,
  observeRelayGeneration,
  observedRelayGeneration,
  openRelayFence,
} from "./reconcile-fence.js";
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
  options: { replaceExisting?: boolean } = {},
): ConnectRelayIdentityResult {
  closeRelayFence(deps.db);
  const expected =
    options.replaceExisting === true
      ? undefined
      : (observedRelayGeneration(deps.db) ?? null);
  const runtime = connectRuntimeForBaseUrl(input.baseUrl);
  const supported =
    runtime !== null && input.serverId !== "" && input.ownerUserId !== "";
  const result = !supported
    ? clearConnectBinding(deps.db, expected)
    : replaceConnectBinding(
        deps.db,
        {
          runtime,
          issuer: RELAY_ASSERTION_ISSUERS[runtime],
          serverId: input.serverId,
          ownerUserId: input.ownerUserId,
        },
        Date.now(),
        expected,
      );
  observeRelayGeneration(deps.db, result.generation);
  for (const cancellation of result.cancellations) {
    notifyRelayCancellation(deps, cancellation);
  }
  if (!supported) return { status: "unsupported_runtime" };
  return { status: result.changed ? "bound" : "unchanged" };
}

export function hasConnectRelayIdentity(deps: Pick<AppDeps, "db">): boolean {
  const binding = getConnectBinding(deps.db);
  return (
    binding !== null &&
    binding.reconciled &&
    isRelayFenceOpen(deps.db, binding.generation)
  );
}

export function markConnectRelayIdentityReconciled(
  deps: Pick<AppDeps, "db">,
  reconciled: boolean,
): boolean {
  closeRelayFence(deps.db);
  if (!reconciled) {
    try {
      const result = setConnectBindingReconciled(
        deps.db,
        false,
        observedRelayGeneration(deps.db) ?? null,
      );
      observeRelayGeneration(
        deps.db,
        result.status === "ok" ? result.generation : null,
      );
      return result.status === "ok";
    } catch (error) {
      if (error instanceof ConnectBindingConflictError) return false;
      throw error;
    }
  }
  const expected = observedRelayGeneration(deps.db);
  if (expected === undefined) {
    throw new Error("relay binding was not observed by this process");
  }
  const result = setConnectBindingReconciled(deps.db, true, expected);
  if (result.status === "missing") return false;
  openRelayFence(deps.db, result.generation);
  return true;
}

export function closeConnectRelayFence(deps: Pick<AppDeps, "db">): void {
  closeRelayFence(deps.db);
}
