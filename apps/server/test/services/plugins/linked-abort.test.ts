import { getEventListeners } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createTestAppHarness } from "../../helpers/test-app.js";
import { describe, expect, it } from "vitest";
import { linkAbortSignals } from "../../../src/services/plugins/linked-abort.js";

describe("linkAbortSignals", () => {
  it("aborts when the caller aborts, with the caller's reason", () => {
    const caller = new AbortController();
    const lifetime = new AbortController();
    const linked = linkAbortSignals(caller.signal, lifetime.signal);
    expect(linked.signal.aborted).toBe(false);
    caller.abort(new Error("caller"));
    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toEqual(new Error("caller"));
    expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(0);
  });

  it("aborts when the plugin lifetime signal aborts", () => {
    const caller = new AbortController();
    const lifetime = new AbortController();
    const linked = linkAbortSignals(caller.signal, lifetime.signal);
    lifetime.abort(new Error("stopping"));
    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toEqual(new Error("stopping"));
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("is aborted immediately when either source is already aborted", () => {
    const aborted = AbortSignal.abort(new Error("early"));
    const live = new AbortController();
    for (const [a, b] of [
      [aborted, live.signal],
      [live.signal, aborted],
    ] as const) {
      const linked = linkAbortSignals(a, b);
      expect(linked.signal.aborted).toBe(true);
      expect(linked.signal.reason).toEqual(new Error("early"));
    }
    expect(getEventListeners(live.signal, "abort")).toHaveLength(0);
  });

  it("detaches both sources when disposed before either aborts", () => {
    const caller = new AbortController();
    const lifetime = new AbortController();
    const linked = linkAbortSignals(caller.signal, lifetime.signal);
    linked.dispose();
    linked.dispose();
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(0);
    caller.abort();
    lifetime.abort();
    expect(linked.signal.aborted).toBe(false);
  });

  it("returns lifetime-signal listeners to baseline after many calls", () => {
    const lifetime = new AbortController();
    const baseline = getEventListeners(lifetime.signal, "abort").length;
    for (let i = 0; i < 5_000; i += 1) {
      const caller = new AbortController();
      const linked = linkAbortSignals(caller.signal, lifetime.signal);
      expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(
        baseline + 1,
      );
      linked.dispose();
      linked.dispose();
      if (i % 2 === 0) caller.abort();
    }
    expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(baseline);
  });
});

it.each([false, true])(
  "detaches a settled RPC from its caller (throws: %s)",
  async (throws) => {
    const harness = await createTestAppHarness();
    const rootDir = await mkdtemp(join(tmpdir(), "bb-linked-abort-"));
    try {
      await writeFile(
        join(rootDir, "package.json"),
        JSON.stringify({
          name: "bb-plugin-linked-abort",
          version: "0.1.0",
          bb: {
            name: "Linked abort fixture",
            description: "RPC cancellation fixture",
            branding: { icon: "Zap" },
            server: "./server.ts",
          },
        }),
      );
      await writeFile(
        join(rootDir, "server.ts"),
        "export default function plugin() {}",
      );
      expect((await harness.pluginService.installPath(rootDir)).status).toBe(
        "running",
      );
      const api = harness.pluginService.getApi("linked-abort");
      if (!api) throw new Error("fixture plugin did not start");
      const signals: AbortSignal[] = [];
      api.rpc.register(
        defineRpcContract({ inspect: { input: z.null(), output: z.null() } }),
        {
          inspect: (_input, context) => {
            signals.push(context.experimental_signal);
            if (throws) throw new Error("fixture failure");
            return null;
          },
        },
      );
      const lookup = harness.pluginService.getRpcHandler(
        "linked-abort",
        "inspect",
      );
      if (lookup.outcome !== "found") throw new Error("fixture RPC not found");
      const lifetime = lookup.owner.stopping.signal;
      const baseline = getEventListeners(lifetime, "abort").length;
      for (let i = 0; i < 100; i += 1) {
        const caller = new AbortController();
        const result = await harness.pluginService.invokeRpcHandler(
          lookup.owner,
          "inspect",
          lookup.value,
          null,
          { kind: "client" },
          caller.signal,
        );
        expect(result.ok).toBe(!throws);
        expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
        expect(getEventListeners(lifetime, "abort")).toHaveLength(baseline);
        caller.abort();
      }
      expect(signals).toHaveLength(100);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
    } finally {
      await harness.pluginService.stop();
      await harness.cleanup();
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);
