import { isThreadEventsCold } from "@bb/db";
import { createDeferredPromise } from "@bb/test-helpers";
import { describe, expect, it, vi } from "vitest";
import { getThreadHistoryPinCount } from "../../src/services/threads/event-cold-tier/pins.js";
import { inferThreadMetadata } from "../../src/services/threads/thread-metadata-inference.js";
import { stopRunningServerWork } from "../../src/services/server-move/stop-work.js";
import {
  attemptColdMove,
  countThreadEvents,
  forceColdEligible,
  seedColdTierEvents,
} from "../helpers/cold-tier.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const generation = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
}));

vi.mock("../../src/services/threads/title-generation.js", async (original) => {
  const actual =
    await original<
      typeof import("../../src/services/threads/title-generation.js")
    >();
  return {
    ...actual,
    generateThreadMetadataWithOutcome: async (...args: unknown[]) => {
      if (generation.gate !== null) await generation.gate;
      return {
        metadata: null,
        reason: "test",
        durationMs: 0,
        ...(args.length < 0 ? {} : {}),
      };
    },
  };
});

let counter = 0;

function seedFixture(
  harness: TestAppHarness,
  status: "active" | "idle" = "idle",
) {
  counter += 1;
  const fixture = seedThreadFixture(harness, {
    session: { id: `host-cold-infer-${counter}` },
    environment: { path: `/tmp/cold-infer-${counter}` },
    thread: { status },
  });
  seedColdTierEvents(harness.db, fixture.thread.id);
  const ids = {
    environmentId: fixture.environment.id,
    projectId: fixture.project.id,
    threadId: fixture.thread.id,
  };
  return { ...fixture, ids };
}

describe("cold tier pins and hydration for inference and server-move stop", () => {
  it("inferThreadMetadata holds a pin across generation and refuses a concurrent move", async () => {
    await withTestHarness(async (harness) => {
      const { ids, thread } = seedFixture(harness);
      forceColdEligible(harness.db, ids);
      const gate = createDeferredPromise<void>();
      generation.gate = gate.promise;
      try {
        const running = inferThreadMetadata(harness.deps, {
          input: textInput("hello"),
          provisioningId: "prov-1",
          threadId: thread.id,
          writeTranscript: false,
        });
        expect(getThreadHistoryPinCount(thread.id)).toBe(1);
        const refused = await attemptColdMove(harness, thread.id);
        expect(refused).toMatchObject({
          outcome: "skipped",
          reason: "pinned",
        });
        gate.resolve();
        await running;
        expect(getThreadHistoryPinCount(thread.id)).toBe(0);
      } finally {
        generation.gate = null;
      }
    });
  });

  it("inferThreadMetadata on a cold thread hydrates it first and releases the pin", async () => {
    await withTestHarness(async (harness) => {
      const { ids, thread } = seedFixture(harness);
      const hotRows = countThreadEvents(harness.db, thread.id);
      forceColdEligible(harness.db, ids);
      const moved = await attemptColdMove(harness, thread.id);
      expect(moved.outcome).toBe("moved");
      expect(isThreadEventsCold(harness.db, thread.id)).toBe(true);
      expect(countThreadEvents(harness.db, thread.id)).toBeLessThan(hotRows);

      await inferThreadMetadata(harness.deps, {
        input: textInput("hello"),
        provisioningId: "prov-2",
        threadId: thread.id,
        writeTranscript: false,
      });

      expect(isThreadEventsCold(harness.db, thread.id)).toBe(false);
      expect(countThreadEvents(harness.db, thread.id)).toBe(hotRows);
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });

  it("stopRunningServerWork holds a pin per running thread until its stop settles", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, ids, thread } = seedFixture(harness, "active");
      const reply = createDeferredPromise<void>();
      const seenStop = createDeferredPromise<void>();
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: async ({ command }) => {
          if (command.type !== "thread.stop")
            throw new Error(`Unexpected command: ${command.type}`);
          seenStop.resolve();
          await reply.promise;
          return { ok: true, result: { providerCheckpointId: null } };
        },
      });

      const stopping = stopRunningServerWork(harness.deps, {
        pollMs: 10,
        targetHostName: "Desktop",
        timeoutMs: 5_000,
      });
      await seenStop.promise;
      expect(getThreadHistoryPinCount(thread.id)).toBeGreaterThan(0);
      forceColdEligible(harness.db, ids);
      const refused = await attemptColdMove(harness, thread.id);
      expect(refused).toMatchObject({ outcome: "skipped", reason: "pinned" });
      reply.resolve();
      await stopping.catch(() => undefined);
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });
});
