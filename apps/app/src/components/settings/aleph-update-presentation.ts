import type {
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
