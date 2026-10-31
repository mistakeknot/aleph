import type { ApiError } from "./errors.js";
import {
  defineRoute,
  jsonRequest,
  jsonResponse,
  noRequest,
  type EmptyInput,
} from "@bb/hono-typed-routes";
import {
  updateUiPreferenceRequestSchema,
  type PathUiPreferenceKey,
  type UiPreferenceResponse,
  type UiPreferencesResponse,
  type UpdateUiPreferenceRequest,
} from "./api/ui-preferences.js";

import {
  acceptWindowSuggestionRequestSchema,
  type AcceptWindowSuggestionRequest,
  type AcceptWindowSuggestionResponse,
  type DismissWindowSuggestionResponse,
  proposeWindowPresetRequestSchema,
  reportWindowRequestSchema,
  type PathWindowPreset,
  type ProposeWindowPresetRequest,
  type ProposeWindowPresetResponse,
  type ReportWindowRequest,
  type ReportWindowResponse,
  type WindowsResponse,
} from "./api/windows.js";

export const WINDOWS_TAG = "windows";

export const windowsRoute = defineRoute({
  path: "/windows",
  method: "get",
  request: noRequest(),
  response: jsonResponse<WindowsResponse>(),
  tags: () => [WINDOWS_TAG],
});

export const reportWindowRoute = defineRoute({
  path: "/windows/report",
  method: "post",
  request: jsonRequest<EmptyInput, ReportWindowRequest>(
    reportWindowRequestSchema,
  ),
  response: jsonResponse<ReportWindowResponse>(),
  invalidates: () => [WINDOWS_TAG],
});

export const proposeWindowPresetRoute = defineRoute({
  path: "/windows/presets/:presetId/suggestion",
  method: "put",
  request: jsonRequest<PathWindowPreset, ProposeWindowPresetRequest>(
    proposeWindowPresetRequestSchema,
  ),
  response: [
    jsonResponse<ProposeWindowPresetResponse>(),
    jsonResponse<ApiError>({ status: 404 }),
  ],
  invalidates: () => ["ui-preferences"],
});

export const UI_PREFERENCES_TAG = "ui-preferences";

export const uiPreferencesRoute = defineRoute({
  path: "/preferences/ui",
  method: "get",
  request: noRequest(),
  response: jsonResponse<UiPreferencesResponse>(),
  tags: () => [UI_PREFERENCES_TAG],
});

export const updateUiPreferenceRoute = defineRoute({
  path: "/preferences/ui/:key",
  method: "put",
  request: jsonRequest<PathUiPreferenceKey, UpdateUiPreferenceRequest>(
    updateUiPreferenceRequestSchema,
  ),
  response: [
    jsonResponse<UiPreferenceResponse>(),
    jsonResponse<ApiError>({ status: 404 }),
    jsonResponse<ApiError>({ status: 409 }),
  ],
  invalidates: () => [UI_PREFERENCES_TAG],
});

export const resetUiPreferenceRoute = defineRoute({
  path: "/preferences/ui/:key",
  method: "delete",
  request: noRequest<PathUiPreferenceKey>(),
  response: [
    jsonResponse<UiPreferenceResponse>(),
    jsonResponse<ApiError>({ status: 404 }),
  ],
  invalidates: () => [UI_PREFERENCES_TAG],
});

export const acceptWindowSuggestionRoute = defineRoute({
  path: "/windows/presets/:presetId/suggestion/accept",
  method: "post",
  request: jsonRequest<PathWindowPreset, AcceptWindowSuggestionRequest>(
    acceptWindowSuggestionRequestSchema,
  ),
  response: [
    jsonResponse<AcceptWindowSuggestionResponse>(),
    jsonResponse<ApiError>({ status: 404 }),
  ],
  invalidates: () => ["ui-preferences"],
});

export const dismissWindowSuggestionRoute = defineRoute({
  path: "/windows/presets/:presetId/suggestion",
  method: "delete",
  request: noRequest<PathWindowPreset>(),
  response: [
    jsonResponse<DismissWindowSuggestionResponse>(),
    jsonResponse<ApiError>({ status: 404 }),
  ],
  invalidates: () => ["ui-preferences"],
});
