import type { MobileRealtimeConnectionState } from "../realtime/mobile-realtime";
import type { SessionState } from "../session/session-scheduler";

type HopEvidence =
  | { status: "unchecked" }
  | { status: "checked-ok" }
  | { status: "checked-failed"; reason: string; authRequired?: boolean };

export interface ConnectionHopEvidence {
  profile: HopEvidence;
  session: HopEvidence;
  tunnel: HopEvidence;
  socket: HopEvidence;
}

const HOPS = ["profile", "session", "tunnel", "socket"] as const;
type ConnectionHop = (typeof HOPS)[number];

export interface ConnectionDiagnosis {
  hop: ConnectionHop;
  headline: string;
  action: string;
  reason: string;
  canSignIn: boolean;
  evidence: ConnectionHopEvidence;
}

export function diagnoseConnection(
  evidence: ConnectionHopEvidence,
): ConnectionDiagnosis | null {
  for (const hop of HOPS) {
    const observation = evidence[hop];
    if (observation.status !== "checked-failed") continue;
    const canSignIn = hop === "session" && observation.authRequired === true;
    const copy = {
      profile: ["Server profile needs attention", "Choose a server profile"],
      session: [
        "Session needs attention",
        canSignIn ? "Sign in again" : "Check your network connection",
      ],
      tunnel: ["Tunnel connection failed", "Check the host connection"],
      socket: ["Live connection lost", "Check your network connection"],
    } as const;
    const [headline, action] = copy[hop];
    return {
      hop,
      headline,
      action,
      reason: observation.reason,
      canSignIn,
      evidence,
    };
  }
  return null;
}

export function observeConnectionHops({
  profileReady,
  hasProfile,
  hasSavedProfileEvidence,
  session,
  realtime,
}: {
  profileReady: boolean;
  hasProfile: boolean;
  hasSavedProfileEvidence: boolean;
  session: SessionState | null;
  realtime: MobileRealtimeConnectionState | null;
}): ConnectionHopEvidence {
  const unchecked: HopEvidence = { status: "unchecked" };
  let sessionEvidence: HopEvidence = unchecked;
  if (session?.status === "auth-required") {
    sessionEvidence = {
      status: "checked-failed",
      reason: session.detail,
      authRequired: true,
    };
  } else if (session?.status === "error") {
    sessionEvidence = { status: "checked-failed", reason: session.detail };
  } else if (session?.status === "authenticated" && !session.restored) {
    sessionEvidence = { status: "checked-ok" };
  }
  return {
    profile: !profileReady
      ? unchecked
      : hasProfile
        ? { status: "checked-ok" }
        : hasSavedProfileEvidence
          ? { status: "checked-failed", reason: "No active server profile" }
          : unchecked,
    session: sessionEvidence,
    tunnel: unchecked,
    socket:
      realtime === "connected"
        ? { status: "checked-ok" }
        : realtime === "reconnecting"
          ? {
              status: "checked-failed",
              reason: "The live connection was interrupted",
            }
          : unchecked,
  };
}
