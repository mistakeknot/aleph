import { hostDaemonConnectAnnotationsRequestSchema } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import type { PluginService } from "../services/plugins/plugin-service.js";
import { ApiError } from "../errors.js";
import { requireAuthenticatedDaemonSession } from "./session-state.js";

export function registerInternalConnectAnnotationRoutes(
  app: Hono,
  deps: Pick<AppDeps, "db">,
  plugins: Pick<PluginService, "list" | "getRpcHandler" | "invokeRpcHandler">,
): void {
  app.post("/session/connect-annotations", async (context) => {
    const payload = hostDaemonConnectAnnotationsRequestSchema.parse(
      await context.req.json(),
    );
    const session = requireAuthenticatedDaemonSession({
      context,
      db: deps.db,
      sessionId: payload.sessionId,
    });
    const plugin = plugins
      .list()
      .find((entry) => entry.source === "builtin:connect");
    if (!plugin)
      throw new ApiError(503, "unavailable", "Connect is unavailable");
    const method =
      payload.change === undefined
        ? "connect.experimental_annotations.list"
        : "connect.experimental_annotations.change";
    const handler = plugins.getRpcHandler(plugin.id, method);
    if (handler.outcome !== "found")
      throw new ApiError(503, "unavailable", "Annotations are unavailable");
    const outcome = await plugins.invokeRpcHandler(
      handler.owner,
      method,
      handler.value,
      {
        hostId: session.hostId,
        port: payload.port,
        url: payload.url,
        ...(payload.change === undefined ? {} : { change: payload.change }),
      },
      { kind: "client" },
      null,
    );
    if (!outcome.ok)
      throw new ApiError(400, "invalid_request", outcome.error.message);
    return new Response(JSON.stringify(outcome.result), {
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
      },
    });
  });
}
