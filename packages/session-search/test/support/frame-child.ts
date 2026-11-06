import { setTimeout as sleep } from "node:timers/promises";

import { FrameDecoder, encodeFrame } from "../../src/ipc/frame.js";
import { openParentChannel } from "../../src/ipc/framed-child.js";

const BODY_CHUNK_BYTES = 16 * 1024;

const mode = process.argv[2] ?? "";
const amount = Number(process.argv[3] ?? "0");
const channel = openParentChannel();
channel.output.on("error", () => process.exit(0));

function header(length: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(length, 0);
  return buffer;
}

function write(bytes: Uint8Array): Promise<void> {
  return new Promise((resolve) => {
    channel.output.write(bytes, () => resolve());
  });
}

async function streamBody(total: number): Promise<void> {
  const chunk = Buffer.alloc(BODY_CHUNK_BYTES, 0x61);
  let remaining = total;
  while (remaining > 0) {
    const take = Math.min(remaining, BODY_CHUNK_BYTES);
    await write(take === BODY_CHUNK_BYTES ? chunk : chunk.subarray(0, take));
    remaining -= take;
  }
}

async function run(): Promise<void> {
  switch (mode) {
    case "echo": {
      const decoder = new FrameDecoder();
      for await (const chunk of channel.input) {
        for (const event of decoder.push(chunk as Buffer)) {
          if (event.kind === "frame") await write(encodeFrame(event.payload));
        }
      }
      return;
    }
    case "advertise":
    case "exact": {
      await write(header(amount));
      await streamBody(amount);
      await sleep(60_000);
      return;
    }
    case "advertise-joined": {
      await write(
        Buffer.concat([header(amount), Buffer.alloc(256 * 1024, 0x61)]),
      );
      await streamBody(amount - 256 * 1024);
      await sleep(60_000);
      return;
    }
    case "truncate": {
      await write(header(amount));
      await write(Buffer.alloc(10, 0x62));
      return;
    }
    case "partial-header": {
      await write(header(1).subarray(0, 2));
      return;
    }
    case "fragment": {
      const frame = encodeFrame(Buffer.from("fragmented"));
      for (let index = 0; index < frame.byteLength; index += 1) {
        await write(frame.subarray(index, index + 1));
        await sleep(3);
      }
      await sleep(60_000);
      return;
    }
    case "burst": {
      const frames = ["one", "two", "three"].map((text) =>
        encodeFrame(Buffer.from(text)),
      );
      await write(Buffer.concat(frames));
      return;
    }
    case "empty": {
      await write(header(0));
      await sleep(60_000);
      return;
    }
    case "exit": {
      process.exit(amount);
    }
    case "hang": {
      await write(encodeFrame(Buffer.from("ready")));
      await sleep(60_000);
      return;
    }
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

run().then(
  () => process.exit(0),
  () => process.exit(2),
);
