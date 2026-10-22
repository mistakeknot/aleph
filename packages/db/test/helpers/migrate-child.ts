import { writeFileSync } from "node:fs";
import { createConnection } from "../../src/connection.js";
import { migrateWithFolders } from "../../src/migrate.js";

const [path, point, upstreamFolder, alephFolder] = process.argv.slice(2);
if (
  path === undefined ||
  point === undefined ||
  upstreamFolder === undefined ||
  alephFolder === undefined
)
  throw new Error("usage: migrate-child <path> <point> <upstream> <aleph>");

function dieNow(): number {
  process.kill(process.pid, "SIGKILL");
  return 0;
}

const db = createConnection(path);
if (point === "mid-transaction") {
  db.$client.function("bb_die", dieNow);
  db.$client.exec(
    "CREATE TEMP TRIGGER bb_die_mid_migration AFTER INSERT ON __drizzle_migrations WHEN (SELECT count(*) FROM __drizzle_migrations) > 140 BEGIN SELECT bb_die(); END",
  );
}
if (process.env.BB_READY_FILE !== undefined)
  writeFileSync(process.env.BB_READY_FILE, String(process.pid));
migrateWithFolders(
  db,
  { upstreamFolder, alephFolder },
  { onBackup: point === "after-backup-finalized" ? dieNow : undefined },
);
db.$client.close();
process.stdout.write("migrated\n");
