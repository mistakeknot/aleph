import { describe, expect, it } from "vitest";
import {
  ALEPH_REQUEST_MIGRATION_REASON,
  ALEPH_REQUEST_OPEN_REASON,
  ALEPH_REQUEST_RECOVERY_REASON,
  ALEPH_REQUEST_UNQUALIFIED_REASON,
  alephCapabilityText,
  alephInstallRequestText,
  alephRequestButton,
  alephRunText,
  alephSelectionText,
} from "./aleph-update-presentation";

const SELECTIONS = [
  "up-to-date",
  "available",
  "migration-required",
  "installed-revoked",
  "not-comparable",
  "manifest-invalid",
  "manifest-expired",
  "manifest-missing",
  "recovery-required",
  "recovering",
] as const;

const RUN_STATES = [
  "queued",
  "running",
  "recovering",
  "succeeded",
  "aborted",
  "rolled-back",
  "recovery-incomplete",
  "refused",
  "unknown",
  "not-found",
] as const;

describe("aleph update presentation", () => {
  it("gives every selection explicit text", () => {
    for (const selection of SELECTIONS) {
      const text = alephSelectionText(selection);
      expect(text.label.length).toBeGreaterThan(3);
      expect(text.label).not.toMatch(/^[—-]+$/u);
    }
    expect(
      new Set(SELECTIONS.map((s) => alephSelectionText(s).label)).size,
    ).toBe(SELECTIONS.length);
  });

  it("gives every capability explicit text", () => {
    const labels = (["absent", "command-only", "startable"] as const).map(
      (capability) => alephCapabilityText(capability),
    );
    expect(new Set(labels).size).toBe(3);
    for (const label of labels) expect(label.length).toBeGreaterThan(3);
  });

  it("gives every run state explicit text", () => {
    for (const state of RUN_STATES) {
      expect(alephRunText(state).length).toBeGreaterThan(3);
    }
  });

  it("marks failure selections as errors and healthy ones as neutral", () => {
    expect(alephSelectionText("manifest-invalid").tone).toBe("error");
    expect(alephSelectionText("installed-revoked").tone).toBe("error");
    expect(alephSelectionText("up-to-date").tone).toBe("neutral");
  });
});

const NO_REQUEST = {
  manifestDigest: null,
  nonce: null,
  requestedAt: null,
  state: "none" as const,
  target: null,
};

const CAPABILITIES = [
  "absent",
  "command-only",
  "request-only",
  "startable",
] as const;

function requestInput(
  selection: (typeof SELECTIONS)[number],
  capability: (typeof CAPABILITIES)[number],
  extra: { detail?: string | null; state?: "none" | "requested" } = {},
) {
  return {
    capability,
    detail: extra.detail ?? null,
    installRequest: { ...NO_REQUEST, state: extra.state ?? "none" },
    installed: { aleph: "0.5.3" },
    selection,
    target: { aleph: "0.5.4" },
  };
}

describe("alephRequestButton", () => {
  it.each(CAPABILITIES)("covers every selection with %s", (capability) => {
    for (const selection of SELECTIONS) {
      const button = alephRequestButton(requestInput(selection, capability));
      if (selection === "up-to-date") {
        expect(button.kind).toBe("hidden");
      } else if (selection === "available" && capability === "startable") {
        expect(button.kind).toBe("hidden");
      } else if (selection === "available") {
        expect(button).toEqual({
          disabled: false,
          kind: "request",
          label: "Request update to 0.5.4",
          reason: null,
        });
      } else {
        expect(button.kind).toBe("request");
        expect(button).toMatchObject({ disabled: true });
        expect((button as { reason: string }).reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("explains the common blocked states", () => {
    expect(
      alephRequestButton(requestInput("recovering", "request-only")),
    ).toMatchObject({ reason: ALEPH_REQUEST_RECOVERY_REASON });
    expect(
      alephRequestButton(requestInput("migration-required", "request-only")),
    ).toMatchObject({ reason: ALEPH_REQUEST_MIGRATION_REASON });
    expect(
      alephRequestButton(requestInput("manifest-missing", "absent")),
    ).toMatchObject({ reason: ALEPH_REQUEST_UNQUALIFIED_REASON });
    expect(
      alephRequestButton(
        requestInput("manifest-missing", "absent", {
          detail: "The trust files are missing.",
        }),
      ),
    ).toMatchObject({ reason: "The trust files are missing." });
  });

  it("blocks a second request while one is open, but recovery wins", () => {
    expect(
      alephRequestButton(
        requestInput("available", "request-only", { state: "requested" }),
      ),
    ).toMatchObject({ disabled: true, reason: ALEPH_REQUEST_OPEN_REASON });
    expect(
      alephRequestButton(
        requestInput("recovery-required", "request-only", {
          state: "requested",
        }),
      ),
    ).toMatchObject({ reason: ALEPH_REQUEST_RECOVERY_REASON });
  });

  it("hides the button when there is no target", () => {
    expect(
      alephRequestButton({
        ...requestInput("available", "request-only"),
        target: null,
      }),
    ).toEqual({ kind: "hidden" });
  });
});

describe("alephInstallRequestText", () => {
  it("describes each state", () => {
    expect(alephInstallRequestText(NO_REQUEST)).toBeNull();
    for (const state of [
      "requested",
      "succeeded",
      "expired",
      "cancelled",
    ] as const) {
      expect(
        alephInstallRequestText({ ...NO_REQUEST, state, target: "0.5.4" }),
      ).toEqual(expect.any(String));
    }
  });
});
