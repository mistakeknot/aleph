import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { createStore } from "../api";
import plugin from "../server";
import { progressNotesTag } from "../shared/tags";

const FILES: Record<string, string> = {
  "/work/progress.md": "  Progress from a file.\n",
};

async function setup() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, title: "CLI worker" }),
        send: async () => undefined,
      },
      files: {
        read: async ({ path }: { path: string }) => {
          const content = FILES[path];
          if (content === undefined) {
            throw new Error(`Path does not exist: ${path}`);
          }
          return {
            path,
            content,
            contentEncoding: "utf8" as const,
            sizeBytes: content.length,
          };
        },
      },
    },
  });
  await plugin(bb);
  const store = createStore(bb);
  const project = store.tasks.createProject({
    name: "CLI Progress",
    prefix: "CPR",
    color: "blue",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Report progress",
  });
  return { harness, store, task };
}

function ok(result: { exitCode: number; stdout: string; stderr: string }) {
  expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: "" });
  return result.stdout;
}

describe("bb tasks progress", () => {
  it("records a note with a proof link from an agent thread and reads it back on show", async () => {
    const { harness, store, task } = await setup();
    const { progressNote } = JSON.parse(
      ok(
        await harness.runCli(
          [
            "progress",
            "cpr-1",
            "--body",
            "  Schema reader done  ",
            "--proof-url",
            "https://example.test/runs/7",
            "--json",
          ],
          { threadId: "thr_cli_worker", projectId: "proj_bb" },
        ),
      ),
    );
    expect(progressNote).toMatchObject({
      taskId: task.id,
      authorName: "agent (thr_cli_worker)",
      threadId: "thr_cli_worker",
      body: "Schema reader done",
      proofUrl: "https://example.test/runs/7",
    });
    expect(harness.experimental_rpcInvalidations.at(-1)).toEqual([
      progressNotesTag(task.id),
    ]);
    expect(store.tasks.listComments(task.id)).toEqual([]);
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);

    const shown = JSON.parse(
      ok(await harness.runCli(["show", "CPR-1", "--json"])),
    );
    expect(shown.progressNotes).toEqual([progressNote]);
    expect(shown.comments).toEqual([]);

    const table = ok(await harness.runCli(["show", "CPR-1"]));
    expect(table).toContain("Progress\n");
    expect(table).toContain("Schema reader done");
    expect(table).toContain("https://example.test/runs/7");
    await harness.dispose();
  });

  it("records a note without a proof link outside a thread and honors --author", async () => {
    const { harness } = await setup();
    const plain = JSON.parse(
      ok(
        await harness.runCli([
          "progress",
          "CPR-1",
          "--body",
          "Started",
          "--json",
        ]),
      ),
    ).progressNote;
    expect(plain).toMatchObject({
      authorName: "cli",
      threadId: null,
      presetName: null,
      proofUrl: null,
    });
    const named = JSON.parse(
      ok(
        await harness.runCli([
          "progress",
          "CPR-1",
          "--body",
          "Named",
          "--author",
          "Release bot",
          "--json",
        ]),
      ),
    ).progressNote;
    expect(named.authorName).toBe("Release bot");
    expect(
      ok(await harness.runCli(["progress", "CPR-1", "--body", "Human"])),
    ).toMatch(/^Recorded progress on CPR-1 {2}[0-7][0-9A-HJKMNP-TV-Z]{25}\s*$/);
    await harness.dispose();
  });

  it("reads the body from a file", async () => {
    const { harness } = await setup();
    const note = JSON.parse(
      ok(
        await harness.runCli([
          "progress",
          "CPR-1",
          "--body-file",
          "/work/progress.md",
          "--json",
        ]),
      ),
    ).progressNote;
    expect(note.body).toBe("Progress from a file.");
    const both = await harness.runCli([
      "progress",
      "CPR-1",
      "--body",
      "x",
      "--body-file",
      "/work/progress.md",
    ]);
    expect(both.exitCode).toBe(1);
    await harness.dispose();
  });

  it.each([
    ["a blank body", ["--body", "   "], "body:"],
    ["a body over 2000 characters", ["--body", "x".repeat(2001)], "body:"],
    [
      "a malformed proof URL",
      ["--body", "ok", "--proof-url", "not a url"],
      "proofUrl:",
    ],
    [
      "a non-http proof URL",
      ["--body", "ok", "--proof-url", "ftp://example.test/x"],
      "proofUrl:",
    ],
    [
      "a proof URL over 2048 characters",
      [
        "--body",
        "ok",
        "--proof-url",
        `https://example.test/${"a".repeat(2049)}`,
      ],
      "proofUrl:",
    ],
  ])(
    "rejects %s with the RPC contract's error and writes nothing",
    async (_name, args, expected) => {
      const { harness, store, task } = await setup();
      const invalidationsBefore = harness.experimental_rpcInvalidations.length;
      const result = await harness.runCli(["progress", "CPR-1", ...args]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(expected);
      expect(store.tasks.listProgressNotes(task.id)).toEqual([]);
      expect(harness.experimental_rpcInvalidations).toHaveLength(
        invalidationsBefore,
      );

      const json = await harness.runCli([
        "progress",
        "CPR-1",
        ...args,
        "--json",
      ]);
      expect(json.exitCode).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining(expected) },
      });
      await harness.dispose();
    },
  );

  it("rejects an unknown task and leaves comment behavior unchanged", async () => {
    const { harness, store, task } = await setup();
    const missing = await harness.runCli([
      "progress",
      "CPR-99",
      "--body",
      "Nowhere",
    ]);
    expect(missing.exitCode).toBe(1);

    const comment = JSON.parse(
      ok(
        await harness.runCli(
          ["comment", "CPR-1", "--body", "Still a comment", "--json"],
          { threadId: "thr_cli_worker", projectId: "proj_bb" },
        ),
      ),
    ).comment;
    expect(comment).toMatchObject({
      kind: "agent",
      threadId: "thr_cli_worker",
      body: "Still a comment",
      notifiedCount: 0,
    });
    expect(store.tasks.listProgressNotes(task.id)).toEqual([]);
    await harness.dispose();
  });
});
