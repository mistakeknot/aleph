import { expect, it, vi } from "vitest";
import { forkToNewWorkspace } from "./fork.js";

const bridge = vi.hoisted(() => ({
  sdk: {
    threads: {
      get: vi.fn(async () => ({
        id: "source",
        environmentId: null,
        title: null,
      })),
      fork: vi.fn(async () => ({ id: "fork" })),
    },
    environments: { get: vi.fn() },
  },
  navigate: { toThread: vi.fn() },
}));
vi.mock("./bridge.js", () => ({ getAppBridge: () => bridge }));

it("tags a workspace fork as a message", async () => {
  await forkToNewWorkspace({
    threadId: "source",
    message: { sourceSeqEnd: 12 },
  } as Parameters<typeof forkToNewWorkspace>[0]);
  expect(bridge.sdk.threads.fork).toHaveBeenCalledWith(
    expect.objectContaining({
      wakeCause: "message",
      wakeRef: expect.any(String),
    }),
  );
});
