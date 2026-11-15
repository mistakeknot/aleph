import { existsSync } from "node:fs";
import { createConnection } from "../../src/connection.js";
import {
  ThreadRoleError,
  claimThreadRole,
  releaseThreadRole,
  transferThreadRole,
} from "../../src/data/thread-roles.js";

const [path, goFile, operation, role, argument, generationText] =
  process.argv.slice(2);
if (
  path === undefined ||
  goFile === undefined ||
  operation === undefined ||
  role === undefined
)
  throw new Error(
    "usage: thread-roles-child <db> <go> <op> <role> [arg] [gen]",
  );

const db = createConnection(path);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
process.stdout.write("ready\n");
while (!existsSync(goFile)) Atomics.wait(sleeper, 0, 0, 1);

const actor = { updatedByKind: "cli" } as const;
let outcome: Record<string, unknown>;
try {
  if (operation === "claim") {
    const state = claimThreadRole(db, { ...actor, role, threadId: argument! });
    outcome = { ok: true, generation: state.generation };
  } else if (operation === "transfer") {
    const state = transferThreadRole(db, {
      ...actor,
      role,
      toThreadId: argument!,
      expectedGeneration: Number(generationText),
    });
    outcome = { ok: true, generation: state.generation };
  } else {
    const state = releaseThreadRole(db, {
      ...actor,
      role,
      expectedGeneration: Number(generationText),
    });
    outcome = { ok: true, generation: state.generation };
  }
} catch (error) {
  outcome =
    error instanceof ThreadRoleError
      ? { ok: false, code: error.code }
      : { ok: false, code: "unexpected", message: String(error) };
}
db.$client.close();
process.stdout.write(`${JSON.stringify(outcome)}\n`);
