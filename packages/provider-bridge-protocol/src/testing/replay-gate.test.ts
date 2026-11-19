import { expect, it } from "vitest";
import { createReplayGate } from "./replay-gate.js";

it("holds only the named frame and permits release before arrival", async () => {
  const gate = createReplayGate(["ack", "approval"]);
  let emitted = false;
  const frame = gate.beforeEmit("ack").then(() => {
    emitted = true;
  });
  await gate.waitForReached("ack");
  expect(emitted).toBe(false);
  expect(gate.hasReached("approval")).toBe(false);
  expect(gate.release("approval")).toBe(true);
  await gate.beforeEmit("approval");
  expect(gate.isReleased("ack")).toBe(false);
  expect(gate.release("ack")).toBe(true);
  expect(gate.release("ack")).toBe(false);
  await frame;
  expect(emitted).toBe(true);
  gate.teardown();
});

it("aborts a held emission without releasing its label", async () => {
  const gate = createReplayGate(["ack"]);
  const controller = new AbortController();
  const frame = gate.beforeEmit("ack", controller.signal);
  const rejection = expect(frame).rejects.toThrow("cancelled");
  controller.abort(new Error("cancelled"));
  await rejection;
  expect(gate.isReleased("ack")).toBe(false);
  gate.teardown();
});

it("tears down reached and unreached waiters without emitting", async () => {
  const gate = createReplayGate(["ack", "approval"]);
  const frame = expect(gate.beforeEmit("ack")).rejects.toThrow("closed");
  const reached = expect(gate.waitForReached("approval")).rejects.toThrow(
    "closed",
  );
  gate.teardown();
  await Promise.all([frame, reached]);
});
