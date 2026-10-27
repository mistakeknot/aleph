import { writeFileSync } from "node:fs";

const database = process.env.FIXTURE_DB;
const doneFile = process.env.FIXTURE_DONE_FILE;
const mode = process.env.FIXTURE_MARKER_MODE;
const busyMs = Number(process.env.FIXTURE_BUSY_MS);
if (!database || !doneFile || !mode || !Number.isFinite(busyMs)) {
  throw new Error("fixture environment incomplete");
}

let stopRequested = false;
process.once("SIGTERM", () => {
  stopRequested = true;
});

function sleepSynchronously(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function publishStartupMarker() {
  writeFileSync(
    `${database}.starting.info`,
    JSON.stringify({ pid: process.pid, updatedAt: Date.now() }),
  );
}

if (mode === "early") {
  publishStartupMarker();
  process.stdout.write("started\n");
  sleepSynchronously(busyMs);
} else {
  process.stdout.write("started\n");
  if (mode === "late") {
    sleepSynchronously(500);
    publishStartupMarker();
    sleepSynchronously(busyMs - 500);
  } else {
    sleepSynchronously(busyMs);
  }
}

writeFileSync(doneFile, "complete");
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write(stopRequested ? "stopped-after-work\n" : "no-stop\n");
process.exit(0);
