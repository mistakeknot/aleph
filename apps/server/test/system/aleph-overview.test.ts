import { describe, expect, it } from "vitest";
import { alephOverviewExportSchema } from "@bb/server-contract";
import { readAlephOverview } from "../../src/services/system/aleph-overview.js";

const now = Date.parse("2026-11-11T12:00:00Z");
const stamp = "2026-11-11T11:59:00Z";
const qualification = {
  source: "release qualification",
  checkedAt: stamp,
  commit: "a".repeat(40),
  version: "0.49.0+aleph.1",
  result: "passed",
};
const exported = {
  installation: null,
  qualification,
  upstream: null,
  sync: null,
  summary: null,
};

describe("read-only Aleph overview", () => {
  it("validates the export and rejects invented results and negative gaps", () => {
    expect(alephOverviewExportSchema.safeParse(exported).success).toBe(true);
    expect(
      alephOverviewExportSchema.safeParse({
        ...exported,
        qualification: { ...qualification, result: "probably passed" },
      }).success,
    ).toBe(false);
    expect(
      alephOverviewExportSchema.safeParse({
        ...exported,
        upstream: {
          source: "watcher",
          checkedAt: stamp,
          release: "0.49.0",
          base: "a".repeat(40),
          head: "b".repeat(40),
          firstParentGap: -1,
        },
      }).success,
    ).toBe(false);
  });
  it("keeps qualified but unpublished evidence independent of the update pointer", async () => {
    const result = await readAlephOverview({
      runningVersion: qualification.version,
      read: async () => JSON.stringify(exported),
      now,
    });
    expect(result.qualification?.result).toBe("passed");
    expect(result.runningVersion).toBe("0.49.0+aleph.1");
    expect(result.installation).toBeNull();
    expect(result).not.toHaveProperty("target");
  });
  it("reports missing and offline exports as unavailable, preserving last known evidence", async () => {
    let text: string | null = JSON.stringify(exported);
    const read = async () => text;
    const previous = await readAlephOverview({
      runningVersion: qualification.version,
      read,
      now,
    });
    text = null;
    const result = await readAlephOverview({
      runningVersion: qualification.version,
      read,
      now,
      previous,
    });
    expect(result.stale).toBe(true);
    expect(result.qualification).toEqual(previous.qualification);
    expect(
      (await readAlephOverview({ runningVersion: "unknown", read, now }))
        .qualification,
    ).toBeNull();
  });
  it("expires sync heartbeats and separates running version from installation records", async () => {
    const result = await readAlephOverview({
      runningVersion: "0.49.0+aleph.2",
      now,
      read: async () =>
        JSON.stringify({
          ...exported,
          installation: {
            source: "install receipt",
            checkedAt: stamp,
            version: qualification.version,
            commit: "a".repeat(40),
            installedAt: null,
          },
          sync: {
            source: "sync job",
            checkedAt: stamp,
            heartbeatAt: "2026-11-10T00:00:00Z",
            phase: "integrating",
          },
        }),
    });
    expect(result.sync).toBeNull();
    expect(result.installation?.version).not.toBe(result.runningVersion);
    expect(result.installation?.installedAt).toBeNull();
  });
});
