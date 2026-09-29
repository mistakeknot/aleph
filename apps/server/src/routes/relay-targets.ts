import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import {
  RELAY_ASSERTION_KEYS,
  validateRelayAssertionKeyTable,
  type RelayAssertionKey,
} from "../services/relay-management/assertion-keys.js";
import type { HumanAssertionDeps } from "../services/relay-management/human-assertion.js";
import {
  addRelayTargetForHuman,
  listRelayTargetsForHuman,
  removeRelayTargetForHuman,
} from "../services/relay-management/targets.js";
import type { AppDeps } from "../types.js";

export function registerRelayTargetRoutesWithKeys(
  app: Hono,
  deps: AppDeps,
  keys: readonly RelayAssertionKey[],
  now?: () => number,
): void {
  const { del, get, put } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.hosts;
  let acceptedKeys = keys;
  try {
    validateRelayAssertionKeyTable(keys, (now ?? Date.now)());
  } catch (error) {
    deps.logger.error(
      { err: error },
      "Relay assertion key table is invalid; rejecting all human assertions",
    );
    acceptedKeys = [];
  }
  const assertionDeps: HumanAssertionDeps = {
    db: deps.db,
    keys: acceptedKeys,
    ...(now === undefined ? {} : { now }),
  };

  get(routes.relayTargets, async (context) => {
    const result = await listRelayTargetsForHuman(
      deps,
      context,
      assertionDeps,
      context.req.param("id"),
    );
    context.header("Cache-Control", "no-store");
    return context.json(result);
  });

  put(routes.addRelayTarget, async (context) => {
    await addRelayTargetForHuman(deps, context, assertionDeps, {
      hostId: context.req.param("id"),
      threadId: context.req.param("threadId"),
    });
    return context.json({ ok: true as const });
  });

  del(routes.removeRelayTarget, async (context) => {
    await removeRelayTargetForHuman(deps, context, assertionDeps, {
      hostId: context.req.param("id"),
      threadId: context.req.param("threadId"),
    });
    return context.json({ ok: true as const });
  });
}

export function registerRelayTargetRoutes(app: Hono, deps: AppDeps): void {
  registerRelayTargetRoutesWithKeys(app, deps, RELAY_ASSERTION_KEYS);
}
