import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "../src/migration-plan.js";
import { applySteps, sourceFolders } from "./helpers/plan-apply.js";
import Database from "better-sqlite3";

describe("prompt cache TTL additive migration", () => {
  it("keeps existing threads and defaults their TTL to null", () => {
    const db = new Database(":memory:");
    try {
      const steps = loadMigrationPlan(sourceFolders).steps;
      const index = steps.findIndex((step) => step.id === "A0017");
      expect(index).toBeGreaterThan(0);
      applySteps(db, sourceFolders, steps.slice(0, index));
      db.exec(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('cache-project', 'Cache', 1, 1)",
      );
      db.exec(
        "INSERT INTO threads (id, project_id, provider_id, status, latest_attention_at, created_at, updated_at) VALUES ('existing', 'cache-project', 'claude-code', 'idle', 1, 1, 1)",
      );
      applySteps(db, sourceFolders, steps.slice(index));
      expect(
        db
          .prepare(
            "SELECT id, prompt_cache_ttl FROM threads WHERE id = 'existing'",
          )
          .get(),
      ).toEqual({ id: "existing", prompt_cache_ttl: null });
      db.exec(
        "UPDATE threads SET prompt_cache_ttl = '1h' WHERE id = 'existing'",
      );
      expect(
        db
          .prepare("SELECT prompt_cache_ttl FROM threads WHERE id = 'existing'")
          .get(),
      ).toEqual({ prompt_cache_ttl: "1h" });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
