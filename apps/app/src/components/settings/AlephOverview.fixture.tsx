import type { SystemAlephUpdateStatus } from "@bb/server-contract";
import { AlephOverviewView } from "./AlephOverview";
import { AlephUpdateRowView } from "./AlephUpdateRow";

export const overviewFixture: SystemAlephUpdateStatus = {
  activeThreadCount: 0,
  capability: "absent",
  detail: "No update manifest has been published.",
  floor: null,
  installed: null,
  lastRun: null,
  predecessor: null,
  selection: "manifest-missing",
  target: null,
  installRequest: {
    state: "none",
    nonce: null,
    target: null,
    requestedAt: null,
    manifestDigest: null,
  },
  overview: {
    runningVersion: "0.49.0+aleph.1",
    stale: false,
    requestRecipientConfigured: false,
    requestDelivery: "unavailable",
    installation: {
      version: "0.49.0+aleph.1",
      commit: "a".repeat(40),
      source: "Installation receipt",
      installedAt: "2026-11-11T02:34:00Z",
      checkedAt: "2026-11-11T16:00:00Z",
    },
    qualification: {
      version: "0.49.0+aleph.1",
      commit: "a".repeat(40),
      result: "passed",
      source: "Release qualification",
      checkedAt: "2026-11-11T16:00:00Z",
    },
    upstream: {
      release: "0.49.0",
      firstParentGap: 103,
      base: "b".repeat(40),
      head: "c".repeat(40),
      source: "Upstream watcher",
      checkedAt: "2026-11-11T16:00:00Z",
    },
    sync: {
      phase: "integrating",
      heartbeatAt: "2026-11-11T16:00:00Z",
      checkedAt: "2026-11-11T16:00:00Z",
      source: "Sync job",
    },
    summary: null,
  },
};

export function AlephOverviewFixture({ populated }: { populated: boolean }) {
  const status: SystemAlephUpdateStatus = populated
    ? overviewFixture
    : {
        ...overviewFixture,
        overview: {
          runningVersion: "0.49.0+aleph.1",
          stale: true,
          installation: null,
          qualification: null,
          upstream: null,
          sync: null,
          summary: null,
          requestRecipientConfigured: false,
          requestDelivery: "unavailable",
        },
      };
  return (
    <AlephOverviewView
      desktopVersion="0.45.0+aleph.0.6.1"
      runningVersion="0.49.0+aleph.1"
      overview={status.overview}
      onRefresh={() => {}}
      refreshing={false}
      server={
        <AlephUpdateRowView
          name="Server"
          status={status}
          request={{
            failure: null,
            finished: null,
            pending: null,
            runState: null,
            unknownMessage: null,
          }}
          onUpdate={() => {}}
          onRollback={() => {}}
          onRecover={() => {}}
          onDismiss={() => {}}
        />
      }
    />
  );
}
