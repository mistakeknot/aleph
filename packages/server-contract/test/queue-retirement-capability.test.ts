import { describe, expect, it } from "vitest";
import {
  QUEUE_RETIREMENT_CAPABILITY,
  buildQueueRetirementCapability,
  hasQueueRetirementGuarantee,
  systemVersionResponseSchema,
} from "@bb/server-contract";

const oldServerResponse = {
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  source: "npm",
  updateAvailable: true,
  isDevelopment: false,
  upgradeCommand: "npx bb-app@latest",
};

describe("queue retirement capability", () => {
  it("parses a version response from a server that predates the field", () => {
    const parsed = systemVersionResponseSchema.parse(oldServerResponse);

    expect(parsed.queueRetirement).toBeUndefined();
    expect(hasQueueRetirementGuarantee(parsed, "G1")).toBe(false);
  });

  it("reads the advertised G1, G2 and G3 guarantees and the single-hop limit from a current server", () => {
    const parsed = systemVersionResponseSchema.parse({
      ...oldServerResponse,
      queueRetirement: QUEUE_RETIREMENT_CAPABILITY,
    });

    expect(parsed.queueRetirement).toEqual({
      version: 1,
      guarantees: ["G1", "G2", "G3", "G4", "G5", "G6"],
      retire: { maxHops: 1 },
    });
    expect(hasQueueRetirementGuarantee(parsed, "G1")).toBe(true);
    expect(hasQueueRetirementGuarantee(parsed, "G2")).toBe(true);
    expect(hasQueueRetirementGuarantee(parsed, "G3")).toBe(true);
  });

  it("parses an advertisement without the retire limit", () => {
    const parsed = systemVersionResponseSchema.parse({
      ...oldServerResponse,
      queueRetirement: { version: 1, guarantees: ["G1", "G2"] },
    });

    expect(parsed.queueRetirement?.retire).toBeUndefined();
  });

  it("tolerates guarantees advertised by a future server", () => {
    const parsed = systemVersionResponseSchema.parse({
      ...oldServerResponse,
      queueRetirement: { version: 1, guarantees: ["G1", "G2"] },
    });

    expect(hasQueueRetirementGuarantee(parsed, "G2")).toBe(true);
  });

  it("does not infer G1 from an advertisement of only G2", () => {
    const parsed = systemVersionResponseSchema.parse({
      ...oldServerResponse,
      queueRetirement: { version: 1, guarantees: ["G2"] },
    });

    expect(hasQueueRetirementGuarantee(parsed, "G1")).toBe(false);
    expect(hasQueueRetirementGuarantee(parsed, "G2")).toBe(true);
  });

  it("does not treat an empty advertisement as a guarantee", () => {
    const parsed = systemVersionResponseSchema.parse({
      ...oldServerResponse,
      queueRetirement: { version: 1, guarantees: [] },
    });

    expect(hasQueueRetirementGuarantee(parsed, "G1")).toBe(false);
  });

  it("lets a pre-field client schema accept the current response", () => {
    const legacySchema = systemVersionResponseSchema.omit({
      queueRetirement: true,
    });

    expect(
      legacySchema.safeParse({
        ...oldServerResponse,
        queueRetirement: QUEUE_RETIREMENT_CAPABILITY,
      }).success,
    ).toBe(true);
  });
});

describe("buildQueueRetirementCapability", () => {
  it("advertises G6 only when user posts are redirected", () => {
    expect(buildQueueRetirementCapability("redirect").guarantees).toContain(
      "G6",
    );
    expect(buildQueueRetirementCapability("refuse").guarantees).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
    ]);
  });
});
