import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import {
  migrations,
  getAutomationRun,
  getAutomation,
  closeAutomationRun,
  createAutomation,
  createManualRun,
} from "./data.js";
import {
  renderPreviousOutcome,
  oneLineOutcome,
  readThreadOutcome,
} from "./outcome.js";
import { executeAgentRun } from "./run.js";
import { parseAutomationExecution } from "./data.js";

describe("run outcomes", () => {
  it("reduces to the first nonempty trimmed line and caps it", () => {
    expect(oneLineOutcome("\n  Done  \nmore")).toBe("Done");
    expect(oneLineOutcome("  " + "a".repeat(400))).toBe("a".repeat(280));
    expect(oneLineOutcome("\n \n")).toBeNull();
  });

  it("leaves prompts without an outcome unchanged", () => {
    expect(renderPreviousOutcome("work", null)).toBe("work");
    expect(renderPreviousOutcome("work", { outcome: null, startedAt: 0 })).toBe(
      "work",
    );
  });

  it.each(["Done", "failed: unavailable", "skipped (check exit 1)"])(
    "prepends %s",
    (outcome) => {
      expect(renderPreviousOutcome("work", { outcome, startedAt: 0 })).toBe(
        `Previous run (1970-01-01T00:00:00.000Z): ${outcome}\nwork`,
      );
    },
  );

  it("migrates existing rows once without changing their data", () => {
    const { bb } = createFakePluginHost();
    const db = bb.storage.database();
    bb.storage.migrate(db, migrations.slice(0, 4));
    db.prepare(
      "INSERT INTO automations (id, project_id, name, trigger_type, trigger_config, run_mode, execution, origin, created_at, updated_at) VALUES ('a', 'p', 'A', 'once', '{}', 'agent', '{}', 'human', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO automation_runs (id, automation_id, run_mode, status, trigger, output, scheduled_for, started_at) VALUES ('r', 'a', 'agent', 'skipped', 'schedule', 'diagnostic', 1, 1)",
    ).run();
    const before = db.prepare("SELECT * FROM automation_runs").get();
    bb.storage.migrate(db, migrations);
    bb.storage.migrate(db, migrations);
    expect(db.prepare("SELECT * FROM automation_runs").get()).toEqual({
      ...before!,
      outcome: null,
    });
    expect(getAutomationRun(db, "r")?.outcome).toBeNull();
  });

  it.each(["failed", "skipped", "succeeded"] as const)(
    "records agent %s and carries it into the next spawn",
    async (status) => {
      const { bb, harness } = createFakePluginHost({
        sdk: {
          threads: {
            spawn: async () => makeThreadResponse({ id: "thr_next" }),
          },
        },
      });
      const db = bb.storage.database();
      bb.storage.migrate(db, migrations);
      createAutomation(db, {
        id: "a",
        projectId: "p",
        name: "A",
        enabled: true,
        trigger: { triggerType: "once", runAt: 1 },
        runMode: "agent",
        execution: {
          mode: "agent",
          prompt: "work",
          providerId: "codex",
          model: "m",
          reasoningLevel: "medium",
          permissionMode: "accept-edits",
          environment: { type: "project-default" },
        },
        origin: "human",
        createdByThreadId: null,
        nextRunAt: 1,
      });
      const { run } = createManualRun(db, {
        automationId: "a",
        runMode: "agent",
        now: 1,
      });
      closeAutomationRun(db, {
        runId: run.id,
        status,
        error: "unavailable\nprivate detail",
        skipReason: "check exit 1",
        output: "diagnostic",
        outcome: "\n Done \nmore",
        now: 2,
      });
      expect(getAutomationRun(db, run.id)).toMatchObject({
        outcome:
          status === "failed"
            ? "failed: unavailable"
            : status === "skipped"
              ? "skipped (check exit 1)"
              : "Done",
        output: "diagnostic",
      });
      const automation = getAutomation(db, "a")!;
      const execution = parseAutomationExecution(automation.execution);
      if (execution.mode !== "agent") throw new Error("expected agent");
      const next = createManualRun(db, {
        automationId: "a",
        runMode: "agent",
        now: 3,
      }).run;
      await executeAgentRun(bb, db, {
        automation,
        execution,
        run: next,
        onFailure: (error) => {
          throw error;
        },
      });
      expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
        wakeCause: "timer",
        wakeRef: next.id,
        prompt: `[bb automation due:a]\n\nPrevious run (1970-01-01T00:00:00.001Z): ${getAutomationRun(db, run.id)!.outcome}\nwork`,
      });
      closeAutomationRun(db, { runId: next.id, status: "succeeded", now: 4 });
      const script = createManualRun(db, {
        automationId: "a",
        runMode: "script",
        now: 5,
      }).run;
      closeAutomationRun(db, {
        runId: script.id,
        status: "failed",
        outcome: "should not be stored",
        output: "script output",
        now: 6,
      });
      expect(getAutomationRun(db, script.id)).toMatchObject({
        outcome: null,
        output: "script output",
      });
    },
  );

  it("reads the latest completed root assistant message across pages", async () => {
    let calls = 0;
    const { bb } = createFakePluginHost({
      sdk: {
        threads: {
          events: {
            list: async () =>
              ++calls === 1
                ? [
                    {
                      seq: 4,
                      type: "item/completed",
                      data: {
                        item: {
                          type: "agentMessage",
                          text: "child",
                          parentToolCallId: "tool",
                        },
                      },
                    },
                  ]
                : [
                    {
                      seq: 3,
                      type: "item/completed",
                      data: {
                        item: {
                          type: "agentMessage",
                          text: "\n  Finished\nmore",
                        },
                      },
                    },
                  ],
          },
        },
      },
    });
    expect(await readThreadOutcome(bb, "thr_run")).toBe("Finished");
    expect(calls).toBe(2);
  });

  it("does not borrow an earlier turn's message", async () => {
    const { bb } = createFakePluginHost({
      sdk: {
        threads: {
          events: {
            list: async () => [
              { seq: 2, type: "client/turn/requested", data: {} },
              {
                seq: 1,
                type: "item/completed",
                data: { item: { type: "agentMessage", text: "old" } },
              },
            ],
          },
        },
      },
    });
    expect(await readThreadOutcome(bb, "thr_run")).toBeNull();
  });
});
