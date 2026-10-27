import { writeFileSync } from "node:fs";
import { deferStopDuringDatabaseStartup } from "../../src/startup-stop-guard.js";

const completionFile = process.env.STOP_GUARD_COMPLETION_FILE;
const busyMs = Number(process.env.STOP_GUARD_BUSY_MS ?? "1500");
const guarded = process.env.STOP_GUARD_ENABLED === "1";
if (completionFile === undefined) throw new Error("completion file required");

const guard = guarded
  ? deferStopDuringDatabaseStartup({
      logger: {
        info: (_fields: unknown, message: string) => console.error(message),
      },
    })
  : null;

process.stdout.write("started\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, busyMs);
writeFileSync(completionFile, "migration-complete");

const stop = guard === null ? null : await guard.settle();
if (stop !== null) {
  process.stdout.write(`stopped-after-migration ${stop}\n`);
  process.exit(0);
}
process.stdout.write("no-stop-requested\n");
setTimeout(() => process.exit(0), 100);
