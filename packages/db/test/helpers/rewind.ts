import type { DbConnection } from "../../src/index.js";

export function dropPluginEnabledFollowsDefaultColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(plugins)")
    .all();
  if (columns.some((column) => column.name === "enabled_follows_default")) {
    db.$client.exec("ALTER TABLE plugins DROP COLUMN enabled_follows_default");
  }
}

const MUSIC_MODE_COLUMNS = ["music_mode", "music_port", "music_secret"];

export function dropMusicModeColumns(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(app_theme)")
    .all();
  for (const name of MUSIC_MODE_COLUMNS) {
    if (!columns.some((column) => column.name === name)) continue;
    db.$client.exec(`ALTER TABLE app_theme DROP COLUMN ${name}`);
  }
}
