import { setTimeout as sleep } from "node:timers/promises";

import { encodeFrame, FrameDecoder } from "../../src/ipc/frame.js";
import { openParentChannel } from "../../src/ipc/framed-child.js";

const MIB = 1024 * 1024;
const STEP_BYTES = 4 * MIB;

const mode = process.argv[2] ?? "";
const targetMib = Number(process.argv[3] ?? "0");
const channel = openParentChannel();
channel.output.on("error", () => process.exit(0));
channel.input.on("error", () => {});
channel.input.on("end", () => process.exit(0));

let releaseGo!: () => void;
const go = new Promise<void>((resolve) => {
  releaseGo = resolve;
});
const decoder = new FrameDecoder();
channel.input.on("data", (chunk: Buffer) => {
  for (const event of decoder.push(chunk)) {
    if (event.kind === "frame" && event.payload.toString() === "go") {
      releaseGo();
    }
  }
});
channel.input.resume();

const held: Buffer[] = [];

function announce(text: string): Promise<void> {
  return new Promise((resolve) => {
    channel.output.write(encodeFrame(Buffer.from(text)), () => resolve());
  });
}

function ready(): Promise<void> {
  return announce("ready");
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
      await ready();
      await go;
      for (let total = 0; total < targetMib * MIB; total += STEP_BYTES) {
        touch(STEP_BYTES);
      }
      await announce("held");
      await sleep(60_000);
      return;
    }
    case "grow": {
      await ready();
      await go;
      for (let total = 0; total < targetMib * MIB; total += STEP_BYTES) {
        touch(STEP_BYTES);
        await sleep(10);
      }
      await sleep(60_000);
      return;
    }
    case "sync-grow": {
      await ready();
      await go;
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
