import { describe, expect, it } from "vitest";
import {
  diagnoseConnection,
  observeConnectionHops,
  type ConnectionHopEvidence,
} from "./connection-diagnosis";
import { deriveConnectionBanner } from "./connection-banner";

const unchecked = { status: "unchecked" } as const;
const ok = { status: "checked-ok" } as const;
const healthy: ConnectionHopEvidence = {
  profile: ok,
  session: ok,
  tunnel: ok,
  socket: ok,
};

describe("connection hop diagnosis", () => {
  it.each([
    ["profile", "Server profile needs attention", "Choose a server profile"],
    ["session", "Session needs attention", "Sign in again"],
    ["tunnel", "Tunnel connection failed", "Check the host connection"],
    ["socket", "Live connection lost", "Check your network connection"],
  ] as const)(
    "identifies a failed %s hop and preserves unchecked evidence",
    (hop, headline, action) => {
      const evidence = {
        profile: unchecked,
        session: unchecked,
        tunnel: unchecked,
        socket: unchecked,
        [hop]: {
          status: "checked-failed" as const,
          reason: "Observed failure",
          ...(hop === "session" ? { authRequired: true } : {}),
        },
      };
      const result = diagnoseConnection(evidence)!;
      expect(result).toMatchObject({
        hop,
        headline,
        action,
        reason: "Observed failure",
        evidence,
      });
      for (const key of ["profile", "session", "tunnel", "socket"] as const) {
        if (key !== hop) expect(result.evidence[key].status).toBe("unchecked");
      }
    },
  );

  it("selects the first failure and offers sign-in only for auth evidence", () => {
    expect(
      diagnoseConnection({
        ...healthy,
        profile: { status: "checked-failed", reason: "Missing" },
        session: {
          status: "checked-failed",
          reason: "Expired",
          authRequired: true,
        },
      })?.hop,
    ).toBe("profile");
    expect(
      diagnoseConnection({
        ...healthy,
        session: { status: "checked-failed", reason: "Network unavailable" },
      })?.action,
    ).toBe("Check your network connection");
    expect(
      diagnoseConnection({
        ...healthy,
        tunnel: { status: "checked-failed", reason: "Origin unreachable" },
      })?.action,
    ).not.toBe("Sign in again");
  });

  it("preserves current output with no failing hop", () => {
    expect(diagnoseConnection(healthy)).toBeNull();
    expect(
      diagnoseConnection({
        profile: unchecked,
        session: unchecked,
        tunnel: unchecked,
        socket: unchecked,
      }),
    ).toBeNull();
    expect(
      deriveConnectionBanner({
        session: { status: "authenticated", expiresAt: 1, restored: false },
        realtime: "connected",
        suspended: false,
        connectingForMs: 0,
      }),
    ).toBe("hidden");
  });

  it("maps only available observations, leaving tunnel and pending sockets unchecked", () => {
    const input = {
      profileReady: true,
      hasProfile: true,
      session: { status: "auth-required" as const, detail: "Expired" },
      realtime: "connecting" as const,
    };
    const evidence = observeConnectionHops(input);
    expect(evidence.tunnel).toEqual(unchecked);
    expect(evidence.socket).toEqual(unchecked);
    expect(diagnoseConnection(evidence)?.action).toBe("Sign in again");
    expect(
      observeConnectionHops({
        ...input,
        session: { status: "idle" },
        realtime: "reconnecting",
      }).socket.status,
    ).toBe("checked-failed");
    expect(
      observeConnectionHops({ ...input, profileReady: false }).profile.status,
    ).toBe("unchecked");
    expect(
      observeConnectionHops({ ...input, hasProfile: false }).profile.status,
    ).toBe("checked-failed");
  });
});
