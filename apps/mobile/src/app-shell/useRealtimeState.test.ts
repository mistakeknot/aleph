import { beforeEach, expect, it, vi } from "vitest";
import { useConnectionBannerState } from "./useRealtimeState";

const state = vi.hoisted(() => ({
  status: "ready",
  activeProfile: null,
  loadError: null as string | null,
  connection: null,
  profiles: [] as { id: string }[],
}));

vi.mock("./ProfilesProvider", () => ({ useProfiles: () => state }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => undefined,
  useState: () => [null, vi.fn()],
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) =>
    getSnapshot(),
}));

beforeEach(() => {
  state.profiles = [];
  state.loadError = null;
});

it("keeps the add-server banner hidden on first run without saved profiles", () => {
  expect(useConnectionBannerState()).toEqual({
    kind: "hidden",
    diagnosis: null,
  });
});

it("keeps the profile diagnosis for a broken or missing saved selection", () => {
  state.profiles = [{ id: "saved-profile" }];
  expect(useConnectionBannerState().diagnosis).toMatchObject({
    hop: "profile",
    headline: "Server profile needs attention",
    action: "Choose a server profile",
  });
});

it("keeps the profile diagnosis when saved profiles could not be read", () => {
  state.loadError = "Saved server could not be read and was skipped.";
  expect(useConnectionBannerState().diagnosis?.hop).toBe("profile");
});
