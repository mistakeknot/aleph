import { expect, it } from "vitest";
import {
  alephInstallEligibility,
  type SystemAlephUpdateStatus,
} from "../src/api/system.js";

function input(installed: string, target: string): SystemAlephUpdateStatus {
  return {
    activeThreadCount: 0,
    capability: "request-only",
    detail: null,
    floor: null,
    lastRun: null,
    predecessor: null,
    selection: "available",
    installed: { aleph: "1", version: installed },
    target: { aleph: "2", version: target, manifestDigest: "a".repeat(64) },
    installRequest: {
      state: "none",
      nonce: null,
      requestedAt: null,
      target: null,
      manifestDigest: null,
    },
    overview: {
      runningVersion: installed,
      installation: null,
      upstream: null,
      sync: null,
      summary: null,
      stale: false,
      requestRecipientConfigured: true,
      requestDelivery: "unavailable",
      qualification: {
        result: "passed",
        version: target,
        commit: "a".repeat(40),
        checkedAt: "2026-10-10T00:00:00Z",
        source: "qualification",
      },
    },
  };
}
it.each([
  ["0.49.0+aleph.9", "0.49.0+aleph.10", true],
  ["0.44.0+aleph.0.5.9", "0.44.0+aleph.0.5.10", true],
  ["0.49.0+aleph.10", "0.49.0+aleph.2", false],
  ["0.49.0+aleph.1", "0.49.0+aleph.1", false],
  ["0.49.0+aleph.1", "0.49.0+aleph.0.6.1", false],
  ["unknown", "0.49.0+aleph.2", false],
] as const)(
  "orders %s to %s numerically and refuses unknown schemes",
  (installed, target, eligible) => {
    expect(alephInstallEligibility(input(installed, target)).eligible).toBe(
      eligible,
    );
  },
);

it("uses the selector comparison input even without an installed record", () => {
  const status = input("0.49.0+aleph.1", "0.49.0+aleph.2");
  status.installed = null;
  status.comparisonVersion = "0.49.0+aleph.1";
  expect(alephInstallEligibility(status)).toEqual({ eligible: true });
});
it("uses the raw running version for legacy responses without a comparison field", () => {
  const status = input("0.49.0+aleph.1", "0.49.0+aleph.2");
  status.installed = null;
  expect(alephInstallEligibility(status)).toEqual({ eligible: true });
});
it("preserves explicit comparison unavailability rather than guessing from overview", () => {
  const status = input("0.49.0+aleph.1", "0.49.0+aleph.2");
  status.comparisonVersion = null;
  expect(alephInstallEligibility(status)).toMatchObject({
    eligible: false,
    reason: "installed-unavailable",
  });
});
