import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import {
  acceptWindowSuggestion,
  dismissWindowSuggestion,
  listWindows,
  proposeWindowPreset,
  recordWindowReport,
} from "../services/system/windows.js";
import type { AppDeps } from "../types.js";

export function registerWindowRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, put } = typedRoutes<PublicApiSchema>(app, {
    invalidateTags: (tags) => deps.hub.notifyTags(tags),
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.system;

  get(routes.windows, (context) =>
    context.json({ windows: listWindows(deps) }),
  );

  post(routes.reportWindow, (context, payload) =>
    context.json({ window: recordWindowReport(deps, payload) }),
  );

  put(routes.proposeWindowPreset, (context, payload) => {
    const presetId = context.req.param("presetId");
    const result = proposeWindowPreset(deps, {
      presetId,
      panes: payload.panes,
      reason: payload.reason ?? null,
      proposedBy: payload.proposedBy ?? "agent",
    });
    if (result.outcome === "not_found") {
      throw new ApiError(
        404,
        "window_preset_not_found",
        `Unknown window preset '${presetId}'.`,
      );
    }
    if (result.outcome === "not_editable") {
      throw new ApiError(
        400,
        "window_preset_not_editable",
        `Window preset '${presetId}' has a fixed layout and takes no suggestions.`,
      );
    }
    if (result.outcome === "conflict") {
      throw new ApiError(
        409,
        "ui_preference_conflict",
        "Window suggestions changed on another client; try again.",
      );
    }
    return context.json({ presetId, suggestion: result.suggestion });
  });

  post(routes.acceptWindowSuggestion, (context, payload) => {
    const presetId = context.req.param("presetId");
    const result = acceptWindowSuggestion(deps, {
      presetId,
      windowId: payload.windowId,
      proposedAt: payload.proposedAt,
    });
    if (result.outcome === "accepted") {
      return context.json({ presetId, panes: result.panes });
    }
    if (result.outcome === "conflict" || result.outcome === "stale") {
      throw new ApiError(
        409,
        result.outcome === "stale"
          ? "window_suggestion_stale"
          : "ui_preference_conflict",
        result.outcome === "stale"
          ? "The suggestion changed since it was shown; review the new one."
          : "Window presets changed on another client; try again.",
      );
    }
    throw new ApiError(
      404,
      "window_suggestion_not_found",
      `No pending suggestion for window preset '${presetId}' in that window.`,
    );
  });

  post(routes.dismissWindowSuggestion, (context, payload) => {
    const presetId = context.req.param("presetId");
    const result = dismissWindowSuggestion(deps, presetId, payload.proposedAt);
    if (result.outcome === "conflict" || result.outcome === "stale") {
      throw new ApiError(
        409,
        "ui_preference_conflict",
        "Window suggestions changed on another client; try again.",
      );
    }
    return context.json({ presetId });
  });
}
