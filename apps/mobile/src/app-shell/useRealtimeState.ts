import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CONNECTING_BANNER_GRACE_MS,
  deriveConnectionBanner,
  diagnoseConnection,
  observeConnectionHops,
  type ConnectionDiagnosis,
  type ConnectionBannerKind,
} from "@/lib/connection";
import type { MobileRealtimeConnectionState } from "@/lib/realtime";
import { useProfiles } from "./ProfilesProvider";

export function useRealtimeConnectionState(): MobileRealtimeConnectionState {
  const { connection } = useProfiles();
  const realtime = connection?.client.realtime ?? null;
  return useSyncExternalStore(
    (listener) => realtime?.onConnectionStateChange(listener) ?? (() => {}),
    () => realtime?.getConnectionState() ?? "connecting",
    () => "connecting",
  );
}

export function useConnectionBanner(): ConnectionBannerKind {
  return useConnectionBannerState().kind;
}

export function useConnectionBannerState(): {
  kind: ConnectionBannerKind;
  diagnosis: ConnectionDiagnosis | null;
} {
  const { connection, activeProfile, status, profiles, loadError } =
    useProfiles();
  const realtimeState = useRealtimeConnectionState();
  const clientKey = connection?.client.profileId ?? null;
  const [graceElapsedFor, setGraceElapsedFor] = useState<string | null>(null);

  useEffect(() => {
    if (realtimeState !== "connecting" || clientKey === null) return;
    const timer = setTimeout(
      () => setGraceElapsedFor(clientKey),
      CONNECTING_BANNER_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [realtimeState, clientKey]);

  const evidence = observeConnectionHops({
    profileReady: status === "ready",
    hasProfile: activeProfile !== null,
    hasSavedProfileEvidence: profiles.length > 0 || loadError !== null,
    session: connection?.session ?? null,
    realtime: connection ? realtimeState : null,
  });
  const suspended = connection?.client.realtime.isSuspended() ?? false;
  const diagnosis = suspended ? null : diagnoseConnection(evidence);
  if (!connection) return { kind: "hidden", diagnosis };
  return {
    diagnosis,
    kind: deriveConnectionBanner({
      session: connection.session,
      realtime: realtimeState,
      suspended,
      connectingForMs:
        graceElapsedFor === clientKey ? CONNECTING_BANNER_GRACE_MS : 0,
    }),
  };
}
