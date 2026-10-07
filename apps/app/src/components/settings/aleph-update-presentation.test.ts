import { describe, expect, it } from "vitest";
import {
  alephCapabilityText,
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
