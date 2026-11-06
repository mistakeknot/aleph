import { setTimeout as sleep } from "node:timers/promises";

import { encodeFrame } from "../../src/ipc/frame.js";
import { openParentChannel } from "../../src/ipc/framed-child.js";

const MIB = 1024 * 1024;
const STEP_BYTES = 4 * MIB;

const mode = process.argv[2] ?? "";
const targetMib = Number(process.argv[3] ?? "0");
const channel = openParentChannel();
channel.output.on("error", () => process.exit(0));
channel.input.on("error", () => {});
channel.input.on("end", () => process.exit(0));
channel.input.resume();

const held: Buffer[] = [];

function ready(): Promise<void> {
  return new Promise((resolve) => {
    channel.output.write(encodeFrame(Buffer.from("ready")), () => resolve());
  });
}

function touch(bytes: number): void {
  held.push(Buffer.alloc(bytes, 1));
}

function spinFor(milliseconds: number): void {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    Math.sqrt(until);
  }
}

async function run(): Promise<void> {
  switch (mode) {
    case "idle": {
      await ready();
      await sleep(60_000);
      return;
    }
    case "hold": {
      for (let total = 0; total < targetMib * MIB; total += STEP_BYTES) {
        touch(STEP_BYTES);
      }
      await ready();
      await sleep(60_000);
      return;
    }
    case "grow": {
      await ready();
      for (let total = 0; total < targetMib * MIB; total += STEP_BYTES) {
        touch(STEP_BYTES);
        await sleep(10);
      }
      await sleep(60_000);
      return;
    }
    case "sync-grow": {
      await ready();
      for (let total = 0; total < targetMib * MIB; total += STEP_BYTES) {
        touch(STEP_BYTES);
        spinFor(5);
      }
      for (;;) spinFor(1000);
    }
    case "spin": {
      await ready();
      for (;;) spinFor(1000);
    }
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

run().then(
  () => process.exit(0),
  () => process.exit(2),
);
