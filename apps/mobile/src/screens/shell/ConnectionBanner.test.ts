import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  diagnoseConnection,
  type ConnectionDiagnosis,
} from "../../lib/connection/connection-diagnosis";
import type { ConnectionBannerKind } from "../../lib/connection/connection-banner";
import { ConnectionBanner } from "./ConnectionBanner";

const state = vi.hoisted(() => ({
  kind: "hidden" as ConnectionBannerKind,
  diagnosis: null as ConnectionDiagnosis | null,
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => undefined,
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("react-native", () => ({
  View: "View",
  Pressable: "Pressable",
  StyleSheet: { hairlineWidth: 1 },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
  FadeInUp: { duration: () => null },
  FadeOutUp: { duration: () => null },
  LinearTransition: { duration: () => null },
}));
vi.mock("@/app-shell", () => ({
  useConnectionBannerState: () => state,
  useProfiles: () => ({
    activeProfile: { id: "profile", label: "My server", mode: "connect" },
  }),
}));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));
vi.mock("@/theme", () => ({ useTheme: () => ({ tokens: {} }) }));
vi.mock("@/ui", () => ({ Icon: "Icon", Text: "Text" }));

function text(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return text(node.props.children);
  return "";
}

beforeEach(() => {
  state.kind = "hidden";
  state.diagnosis = null;
});

it.each([
  ["connecting", "Connecting to My server…"],
  ["reconnecting", "Connection to My server lost. Reconnecting…"],
  ["auth-error", "Could not sign in to My server. Retrying…"],
] as const)(
  "preserves the existing %s banner copy without a failing hop",
  (kind, expected) => {
    state.kind = kind;
    expect(text(ConnectionBanner())).toBe(expected);
  },
);
it("keeps the healthy banner hidden", () => {
  expect(ConnectionBanner()).toBeNull();
});
it.each(["profile", "session", "tunnel", "socket"] as const)(
  "renders headline and action for the failing %s hop",
  (hop) => {
    state.diagnosis = diagnoseConnection({
      profile: { status: "unchecked" },
      session: { status: "unchecked" },
      tunnel: { status: "unchecked" },
      socket: { status: "unchecked" },
      [hop]: {
        status: "checked-failed",
        reason: "Fixture failure",
        authRequired: true,
      },
    });
    const rendered = text(ConnectionBanner());
    expect(rendered).toContain(state.diagnosis!.headline);
    expect(rendered).toContain(state.diagnosis!.action);
    expect(rendered.includes("Sign in again")).toBe(hop === "session");
  },
);
