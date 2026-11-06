import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openParentChannel } from "../../src/ipc/framed-child.js";
import { runWriterChild } from "../../src/writer/child.js";
import {
  WRITER_STORE_DIR_ENV,
  openWriterStore,
} from "../../src/writer/store.js";

const MIB = 1024 * 1024;
const controlDir = process.env.WRITER_TEST_CONTROL_DIR;
const storeDir = process.env[WRITER_STORE_DIR_ENV];
if (storeDir === undefined || controlDir === undefined) process.exit(2);
appendFileSync(join(controlDir, "pids.log"), `${process.pid}\n`);
if (existsSync(join(controlDir, "outage"))) process.exit(3);

function armed(name: string): boolean {
  const path = join(controlDir!, name);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
  } catch {
    return false;
  }
  return true;
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const held: Buffer[] = [];

function bloat(): void {
  for (let index = 0; index < 64; index += 1) {
    held.push(Buffer.alloc(8 * MIB, index + 1));
    pause(5);
  }
  pause(600_000);
}

setInterval(() => {
  if (armed("arm-bloat-idle")) bloat();
}, 20).unref();
const channel = openParentChannel();
channel.output.on("error", () => process.exit(0));
const store = openWriterStore(storeDir, {
  tempDirMode: "unmanaged",
  testHooks: {
    afterAdmission: () => {
      if (armed("arm-bloat")) bloat();
      if (armed("arm-hold")) {
        writeFileSync(join(controlDir!, "held"), "1");
        while (!existsSync(join(controlDir!, "release"))) pause(10);
      }
    },
    afterApply: () => {
      if (armed("arm-kill-before-commit")) {
        process.kill(process.pid, "SIGKILL");
      }
    },
  },
});
runWriterChild(channel, store, {
  beforeResponse: (request) => {
    if (request.t === "cursor" && armed("arm-bloat-cursor")) bloat();
    if (request.t === "commit" && armed("arm-kill-before-ack")) {
      process.kill(process.pid, "SIGKILL");
    }
  },
}).then(
  (code) => {
    store.close();
    process.exit(code);
  },
  () => process.exit(1),
);
