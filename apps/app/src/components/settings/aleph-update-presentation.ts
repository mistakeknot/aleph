import { ALEPH_NO_MANIFEST_PUBLISHED_DETAIL } from "@bb/server-contract";
import type {
  AlephInstallRequest,
  AlephUpdateCapability,
  AlephUpdateRunState,
  AlephUpdateSelection,
} from "@bb/server-contract";

export interface AlephSelectionText {
  label: string;
  tone: "neutral" | "attention" | "error";
}

const SELECTION_TEXT: Record<AlephUpdateSelection, AlephSelectionText> = {
  "up-to-date": { label: "Up to date", tone: "neutral" },
  available: { label: "Update available", tone: "attention" },
  "migration-required": {
    label: "Update needs a database migration",
    tone: "attention",
  },
  "installed-revoked": {
    label: "Installed release was revoked",
    tone: "error",
  },
  "not-comparable": {
    label: "Installed version cannot be compared with the manifest",
    tone: "error",
  },
  "manifest-invalid": { label: "Update manifest is invalid", tone: "error" },
  "manifest-expired": { label: "Update manifest has expired", tone: "error" },
  "manifest-missing": {
    label: "No update manifest is published",
    tone: "neutral",
  },
  "recovery-required": { label: "Recovery required", tone: "error" },
  recovering: { label: "Recovery in progress", tone: "attention" },
};

const CAPABILITY_TEXT: Record<AlephUpdateCapability, string> = {
  absent: "The update helper is not installed on this machine",
  "command-only": "Updates start from a root shell on this machine",
  "request-only":
    "Updates are installed by the gated release install; request one from here",
  startable: "Updates can be started from here",
};

const RUN_TEXT: Record<AlephUpdateRunState, string> = {
  queued: "Update queued",
  running: "Update running",
  recovering: "Recovery running",
  succeeded: "Update succeeded",
  aborted: "Update aborted, nothing changed",
  "rolled-back": "Update failed and was rolled back",
  "recovery-incomplete": "Recovery did not finish",
  refused: "Update refused",
  unknown: "Update finished with an unknown outcome",
  "not-found": "Waiting for the update to start",
};

export function alephSelectionText(
  selection: AlephUpdateSelection,
): AlephSelectionText {
  return SELECTION_TEXT[selection];
}

export function alephCapabilityText(capability: AlephUpdateCapability): string {
  return CAPABILITY_TEXT[capability];
}

export function alephRunText(state: AlephUpdateRunState): string {
  return RUN_TEXT[state];
}

export function isAlephWrapperManaged(status: {
  capability: AlephUpdateCapability;
  selection: AlephUpdateSelection;
  detail: string | null;
}): boolean {
  return (
    status.capability === "absent" &&
    status.selection === "manifest-missing" &&
    status.detail === ALEPH_NO_MANIFEST_PUBLISHED_DETAIL
  );
}

export const ALEPH_WRAPPER_LABEL = "Installed by the Aleph release wrapper";
export const ALEPH_WRAPPER_NOTE =
  "New releases are installed on this machine by the release wrapper, not from this screen.";

export type AlephRequestButton =
  | { kind: "hidden" }
  | {
      kind: "request";
      disabled: boolean;
      label: string;
      reason: string | null;
    };

export const ALEPH_REQUEST_OPEN_REASON =
  "Requested; waiting for the gated install";
export const ALEPH_REQUEST_RECOVERY_REASON = "Recover first";
export const ALEPH_REQUEST_MIGRATION_REASON =
  "Needs a database migration; requires the gated install";
export const ALEPH_REQUEST_UNQUALIFIED_REASON =
  "No release has been qualified yet";

export function alephRequestButton(status: {
  capability: AlephUpdateCapability;
  detail: string | null;
  installRequest: AlephInstallRequest;
  installed: { aleph: string } | null;
  selection: AlephUpdateSelection;
  target: { aleph: string } | null;
}): AlephRequestButton {
  const blocked = (reason: string): AlephRequestButton => ({
    disabled: true,
    kind: "request",
    label: "Request update",
    reason,
  });
  const { selection } = status;
  if (status.capability === "startable" && selection === "available") {
    return { kind: "hidden" };
  }
  if (selection === "recovery-required" || selection === "recovering") {
    return blocked(ALEPH_REQUEST_RECOVERY_REASON);
  }
  if (selection === "up-to-date") return { kind: "hidden" };
  if (status.installRequest.state === "requested") {
    return blocked(ALEPH_REQUEST_OPEN_REASON);
  }
  switch (selection) {
    case "available": {
      if (status.target === null) return { kind: "hidden" };
      if (status.installed?.aleph === status.target.aleph) {
        return blocked("This release is already installed");
      }
      return {
        disabled: false,
        kind: "request",
        label: `Request update to ${status.target.aleph}`,
        reason: null,
      };
    }
    case "migration-required":
      return blocked(ALEPH_REQUEST_MIGRATION_REASON);
    case "manifest-missing":
      return blocked(
        status.detail === null ||
          status.detail === ALEPH_NO_MANIFEST_PUBLISHED_DETAIL
          ? ALEPH_REQUEST_UNQUALIFIED_REASON
          : status.detail,
      );
    default:
      return blocked(SELECTION_TEXT[selection].label);
  }
}

export function alephInstallRequestText(
  request: AlephInstallRequest,
): string | null {
  switch (request.state) {
    case "none":
      return null;
    case "requested":
      return `Update to ${request.target ?? "the latest release"} requested; waiting for the gated install.`;
    case "succeeded":
      return `Requested update to ${request.target ?? "the latest release"} is installed.`;
    case "expired":
      return "The install request expired; request it again if the update is still wanted.";
    case "cancelled":
      return "The install request was cancelled.";
  }
}
