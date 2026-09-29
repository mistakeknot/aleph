import {
  relayTargetsRemoveRequestSchema,
  type RelayTargetsRemoveResponse,
  type RelayTargetsResponse,
} from "@bb/host-daemon-contract/relay";
import {
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import {
  listOwnRelayTargets,
  removeOwnRelayTargets,
} from "../services/relay-management/targets.js";
import type { AppDeps } from "../types.js";
import { getAuthenticatedDaemon } from "./auth.js";

export function registerInternalRelayTargetRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { get, post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  get("/relay/targets", (context) => {
    const { hostId } = getAuthenticatedDaemon(context);
    const response: RelayTargetsResponse = {
      targets: listOwnRelayTargets(deps, hostId).map((target) => ({
        threadId: target.threadId,
        createdAt: new Date(target.createdAt).toISOString(),
      })),
    };
    return context.json(response);
  });

  post(
    "/relay/targets/remove",
    relayTargetsRemoveRequestSchema,
    (context, payload) => {
      const { hostId } = getAuthenticatedDaemon(context);
      const response: RelayTargetsRemoveResponse = removeOwnRelayTargets(deps, {
        hostId,
        ...(payload.threadId === undefined
          ? {}
          : { threadId: payload.threadId }),
      });
      return context.json(response);
    },
  );
}
