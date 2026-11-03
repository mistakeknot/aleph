import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { PIN_MIGRATIONS } from "./pin-migrations.js";
import plugin from "./server.js";

const ROOT = "/work/proj";
const CUJ = `${ROOT}/docs/wiki/src/cujs/boss.md`;
const TAG = "design-wiki:pin-tasks:p1";

const PAGE = `---\nid: cuj-boss\nstatus: open\ncard: ""\nsource: docs/x.md\nupdated: 2026-11-03\n---\n\n# Boss\n\n**Open: first question**\ntext\n`;

const CLAIM = {
  label: "Open: first question",
  context: "**Open: first question**",
  ordinal: 0,
  groupSize: 1,
};

interface FakeTask {
  id: string;
  projectId: string;
  key: string;
  title: string;
  description: string;
  status: string;
}

interface Tasks {
  boards: { id: string; name: string; prefix: string; linked: string | null }[];
  tasks: Map<string, FakeTask>;
  threads: Map<string, Record<string, unknown>[]>;
  pullRequests: Map<
    string,
    { pullRequests: Record<string, unknown>[]; unavailableThreadIds: string[] }
  >;
  failing: Set<string>;
  refuse: string | null;
  calls: { method: string; input: Record<string, any> }[];
  next: number;
}

function newTasks(): Tasks {
  return {
    boards: [{ id: "B1", name: "Board one", prefix: "ONE", linked: "p1" }],
    tasks: new Map(),
    threads: new Map(),
    pullRequests: new Map(),
    failing: new Set(),
    refuse: null,
    calls: [],
    next: 1,
  };
}

function taskJson(task: FakeTask) {
  return {
    id: task.id,
    projectId: task.projectId,
    number: 1,
    key: task.key,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: "none",
    dueDate: null,
    parentTaskId: null,
    position: 0,
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
    labelIds: [],
  };
}

function tasksBackend(tasks: Tasks) {
  return async (args: {
    pluginId: string;
    method: string;
    input?: unknown;
    outputSchema: { parse(value: unknown): unknown };
  }) => {
    if (args.pluginId !== "tasks") throw new Error("unexpected plugin");
    const input = (args.input ?? {}) as Record<string, any>;
    tasks.calls.push({ method: args.method, input });
    if (tasks.failing.has(args.method)) {
      throw new Error(`tasks ${args.method} failed`);
    }
    let result: unknown;
    if (args.method === "listProjects") {
      result = {
        projects: tasks.boards.map((board) => ({
          id: board.id,
          name: board.name,
          prefix: board.prefix,
          nextTaskNumber: 1,
          color: "#fff",
          folderId: null,
          linkedBbProjectId: board.linked,
          createdAt: "2026-11-03T00:00:00.000Z",
        })),
      };
    } else if (args.method === "createTask") {
      if (tasks.refuse !== null) {
        result = {
          ok: false,
          error: { code: "task_parent_invalid", message: tasks.refuse },
        };
      } else {
        const board = tasks.boards.find((item) => item.id === input.projectId);
        const number = tasks.next++;
        const task: FakeTask = {
          id: `TASK${number}`,
          projectId: input.projectId,
          key: `${board?.prefix ?? "X"}-${number}`,
          title: input.title,
          description: input.description,
          status: input.status ?? "backlog",
        };
        tasks.tasks.set(task.id, task);
        result = { ok: true, task: taskJson(task) };
      }
    } else if (args.method === "getTask") {
      const task = tasks.tasks.get(input.taskId);
      result = { task: task === undefined ? null : taskJson(task) };
    } else if (args.method === "getTaskByKey") {
      const task = [...tasks.tasks.values()].find(
        (item) => item.key === input.taskKey,
      );
      result = { task: task === undefined ? null : taskJson(task) };
    } else if (args.method === "listTaskThreads") {
      result = { taskThreads: tasks.threads.get(input.taskId) ?? [] };
    } else if (args.method === "listTaskPullRequests") {
      result = tasks.pullRequests.get(input.taskId) ?? {
        pullRequests: [],
        unavailableThreadIds: [],
      };
    } else {
      throw new Error(`unexpected tasks method ${args.method}`);
    }
    return args.outputSchema.parse(JSON.parse(JSON.stringify(result)));
  };
}

async function setup(tasks: Tasks = newTasks()) {
  const host = createFakePluginHost({
    pluginId: "bb--design-wiki",
    sdk: {
      projects: {
        list: async () => [],
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          name: "Proj",
          sources: [
            {
              type: "local_path",
              hostId: "host-1",
              path: ROOT,
              isDefault: true,
            },
          ],
        }),
      },
      threads: { get: async () => ({ id: "t1", projectId: "p1" }) },
      files: {
        listPaths: async ({ path }: { path: string }) => ({
          paths: [CUJ]
            .filter((file) => file.startsWith(`${path}/`))
            .map((file) => ({
              kind: "file",
              path: file.slice(path.length + 1),
              name: "boss.md",
            })),
          truncated: false,
        }),
        read: async ({ path }: { path: string }) => ({
          path,
          content: PAGE,
          contentEncoding: "utf8",
          sizeBytes: PAGE.length,
          sha256: "x",
        }),
      },
      plugins: { callRpc: tasksBackend(tasks) },
    },
  });
  await plugin(host.bb);
  return { host, tasks };
}

type Fake = Awaited<ReturnType<typeof setup>>;

async function createPin(fake: Fake, input: Record<string, unknown> = {}) {
  const result = (await fake.host.harness.callRpc("createPin", {
    projectId: "p1",
    pageId: "cuj-boss",
    claim: CLAIM,
    body: "Decide the first question\nwith more detail",
    ...input,
  })) as { pin: { id: string } };
  return result.pin.id;
}

async function makeTask(
  fake: Fake,
  pinId: string,
  input: Record<string, unknown> = {},
) {
  return (await fake.host.harness.callRpc("createPinTask", {
    projectId: "p1",
    pinId,
    ...input,
  })) as Record<string, any>;
}

async function linkTask(fake: Fake, pinId: string, taskKey: string) {
  return (await fake.host.harness.callRpc("linkPinTask", {
    projectId: "p1",
    pinId,
    taskKey,
  })) as Record<string, any>;
}

async function pinTasks(fake: Fake) {
  return (await fake.host.harness.callRpc("pinTasks", {
    projectId: "p1",
  })) as Record<string, any>[];
}

function rows(fake: Fake) {
  return fake.host.bb.storage
    .database()
    .prepare(
      "SELECT pin_id, task_id, task_key, task_project_id FROM pin_tasks ORDER BY task_key",
    )
    .all() as Record<string, string>[];
}

function called(fake: Fake, method: string) {
  return fake.tasks.calls.filter((call) => call.method === method);
}

describe("pin tasks: migration 2", () => {
  it("appends pin_tasks and leaves the shipped statement untouched", () => {
    expect(PIN_MIGRATIONS).toHaveLength(2);
    expect(PIN_MIGRATIONS[0]).toContain("CREATE TABLE pin_threads");
    expect(PIN_MIGRATIONS[1]).toContain("CREATE TABLE pin_tasks");
  });

  it("upgrades a database that only has migration 1 and keeps its pins", async () => {
    const host = createFakePluginHost({ pluginId: "bb--design-wiki" });
    host.bb.storage.migrate(host.bb.storage.database(), [PIN_MIGRATIONS[0]!]);
    host.bb.storage
      .database()
      .prepare(
        "INSERT INTO pins (id, project_id, page_id, source_path, body, created_at, updated_at) VALUES ('old', 'p1', 'cuj-boss', 'x.md', 'kept', 'a', 'a')",
      )
      .run();
    const reloaded = await host.harness.lifecycle.reload(plugin);
    const db = reloaded.bb.storage.database();
    expect(db.prepare("SELECT body FROM pins").all()).toEqual([
      { body: "kept" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pin_tasks").get()).toEqual({
      n: 0,
    });
  });

  it("stores the stable task id and the display key separately", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    expect(rows(fake)).toEqual([
      {
        pin_id: pinId,
        task_id: "TASK1",
        task_key: "ONE-1",
        task_project_id: "B1",
      },
    ]);
  });

  it("removes task links when the pin is deleted", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    await fake.host.harness.callRpc("deletePin", { projectId: "p1", pinId });
    expect(rows(fake)).toEqual([]);
  });
});

describe("pin tasks: Make task", () => {
  it("creates a card on the board linked to the project, with a back-link", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    const result = await makeTask(fake, pinId);
    expect(result).toEqual({ ok: true, task: { id: "TASK1", key: "ONE-1" } });
    const [create] = called(fake, "createTask");
    expect(create?.input.projectId).toBe("B1");
    expect(create?.input.title).toBe("Decide the first question");
    const description = create?.input.description as string;
    expect(description).toContain(
      "Decide the first question\nwith more detail",
    );
    expect(description).toContain(`Design wiki pin: ${pinId}`);
    expect(description).toContain("Page: cuj-boss");
    expect(description).toContain("Claim: Open: first question");
    expect(description).toContain("Project: p1");
    expect(description).toContain(
      "[Open this pin's page in the design wiki](/plugins/bb--design-wiki/wiki/p1/cuj-boss)",
    );
  });

  it("caps the card title", async () => {
    const fake = await setup();
    const pinId = await createPin(fake, { body: "x".repeat(500) });
    await makeTask(fake, pinId);
    expect(called(fake, "createTask")[0]?.input.title).toHaveLength(120);
  });

  it("explains and creates nothing when no board is linked", async () => {
    const tasks = newTasks();
    tasks.boards = [{ id: "B9", name: "Other", prefix: "OTH", linked: "p2" }];
    const fake = await setup(tasks);
    const pinId = await createPin(fake);
    const result = await makeTask(fake, pinId);
    expect(result).toMatchObject({ ok: false, reason: "no-board", boards: [] });
    expect(result.message).toMatch(/no task board/i);
    expect(called(fake, "createTask")).toHaveLength(0);
    expect(rows(fake)).toEqual([]);
  });

  it("asks which board when several are linked and picks none silently", async () => {
    const tasks = newTasks();
    tasks.boards.push({
      id: "B2",
      name: "Board two",
      prefix: "TWO",
      linked: "p1",
    });
    const fake = await setup(tasks);
    const pinId = await createPin(fake);
    const asked = await makeTask(fake, pinId);
    expect(asked).toMatchObject({ ok: false, reason: "board-required" });
    expect(asked.boards).toEqual([
      { id: "B1", name: "Board one", prefix: "ONE" },
      { id: "B2", name: "Board two", prefix: "TWO" },
    ]);
    expect(called(fake, "createTask")).toHaveLength(0);
    const chosen = await makeTask(fake, pinId, { taskProjectId: "B2" });
    expect(chosen).toEqual({ ok: true, task: { id: "TASK1", key: "TWO-1" } });
    expect(rows(fake)[0]?.task_project_id).toBe("B2");
  });

  it("refuses a board that is not linked to the project", async () => {
    const tasks = newTasks();
    tasks.boards.push({ id: "B9", name: "Other", prefix: "OTH", linked: "p2" });
    const fake = await setup(tasks);
    const pinId = await createPin(fake);
    const result = await makeTask(fake, pinId, { taskProjectId: "B9" });
    expect(result).toMatchObject({ ok: false, reason: "wrong-board" });
    expect(called(fake, "createTask")).toHaveLength(0);
  });

  it("lets one pin hold several cards", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    await makeTask(fake, pinId);
    expect(rows(fake).map((row) => row.task_key)).toEqual(["ONE-1", "ONE-2"]);
    expect((await pinTasks(fake)).map((item) => item.key)).toEqual([
      "ONE-1",
      "ONE-2",
    ]);
  });

  it("does not find a pin of another project", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    const result = (await fake.host.harness.callRpc("createPinTask", {
      projectId: "p2",
      pinId,
    })) as Record<string, any>;
    expect(result).toMatchObject({ ok: false, reason: "not-found" });
    expect(called(fake, "createTask")).toHaveLength(0);
  });

  it("shows a tasks plugin failure and creates nothing", async () => {
    const tasks = newTasks();
    tasks.failing.add("listProjects");
    const fake = await setup(tasks);
    const pinId = await createPin(fake);
    const result = await makeTask(fake, pinId);
    expect(result).toMatchObject({ ok: false, reason: "tasks-unavailable" });
    expect(result.message).toContain("tasks listProjects failed");
    expect(rows(fake)).toEqual([]);
  });

  it("shows the reason when the tasks plugin refuses the card", async () => {
    const tasks = newTasks();
    tasks.refuse = "parent is invalid";
    const fake = await setup(tasks);
    const pinId = await createPin(fake);
    const result = await makeTask(fake, pinId);
    expect(result).toMatchObject({ ok: false, reason: "tasks-refused" });
    expect(result.message).toContain("parent is invalid");
    expect(rows(fake)).toEqual([]);
  });

  it("reports a created card whose link failed, without retrying createTask", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    const db = fake.host.bb.storage.database();
    db.exec(
      "CREATE TRIGGER fail_link BEFORE INSERT ON pin_tasks BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const result = await makeTask(fake, pinId);
    expect(result).toMatchObject({
      ok: false,
      reason: "not-linked",
      task: { id: "TASK1", key: "ONE-1" },
    });
    expect(result.message).toContain("ONE-1");
    expect(called(fake, "createTask")).toHaveLength(1);
    expect(rows(fake)).toEqual([]);
    db.exec("DROP TRIGGER fail_link");
    const linked = await linkTask(fake, pinId, "ONE-1");
    expect(linked).toEqual({ ok: true, task: { id: "TASK1", key: "ONE-1" } });
    expect(rows(fake)).toHaveLength(1);
    expect(called(fake, "createTask")).toHaveLength(1);
  });
});

describe("pin tasks: Link existing card", () => {
  async function withCard(tasks: Tasks, board = "B1", key = "ONE-7") {
    tasks.tasks.set("TASK7", {
      id: "TASK7",
      projectId: board,
      key,
      title: "Existing",
      description: "",
      status: "todo",
    });
    return setup(tasks);
  }

  it("associates a card found by its display key", async () => {
    const fake = await withCard(newTasks());
    const pinId = await createPin(fake);
    const result = await linkTask(fake, pinId, "ONE-7");
    expect(result).toEqual({ ok: true, task: { id: "TASK7", key: "ONE-7" } });
    expect(rows(fake)).toEqual([
      {
        pin_id: pinId,
        task_id: "TASK7",
        task_key: "ONE-7",
        task_project_id: "B1",
      },
    ]);
  });

  it("is idempotent for a card that is already linked", async () => {
    const fake = await withCard(newTasks());
    const pinId = await createPin(fake);
    await linkTask(fake, pinId, "ONE-7");
    await linkTask(fake, pinId, "ONE-7");
    expect(rows(fake)).toHaveLength(1);
  });

  it("reports an unknown key", async () => {
    const fake = await withCard(newTasks());
    const pinId = await createPin(fake);
    expect(await linkTask(fake, pinId, "ONE-99")).toMatchObject({
      ok: false,
      reason: "task-not-found",
    });
  });

  it("refuses a card on a board that is not linked to the project", async () => {
    const tasks = newTasks();
    tasks.boards.push({ id: "B9", name: "Other", prefix: "OTH", linked: "p2" });
    const fake = await withCard(tasks, "B9", "OTH-7");
    const pinId = await createPin(fake);
    expect(await linkTask(fake, pinId, "OTH-7")).toMatchObject({
      ok: false,
      reason: "wrong-board",
    });
    expect(rows(fake)).toEqual([]);
  });

  it("does not find a pin of another project", async () => {
    const fake = await withCard(newTasks());
    const pinId = await createPin(fake);
    const result = (await fake.host.harness.callRpc("linkPinTask", {
      projectId: "p2",
      pinId,
      taskKey: "ONE-7",
    })) as Record<string, any>;
    expect(result).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("shows a tasks plugin failure", async () => {
    const tasks = newTasks();
    const fake = await withCard(tasks);
    const pinId = await createPin(fake);
    tasks.failing.add("getTaskByKey");
    expect(await linkTask(fake, pinId, "ONE-7")).toMatchObject({
      ok: false,
      reason: "tasks-unavailable",
    });
  });

  it("unlinks a card without touching the card", async () => {
    const fake = await withCard(newTasks());
    const pinId = await createPin(fake);
    await linkTask(fake, pinId, "ONE-7");
    const result = await fake.host.harness.callRpc("unlinkPinTask", {
      projectId: "p1",
      pinId,
      taskId: "TASK7",
    });
    expect(result).toEqual({ removed: true });
    expect(rows(fake)).toEqual([]);
    expect(fake.tasks.tasks.has("TASK7")).toBe(true);
    expect(
      await fake.host.harness.callRpc("unlinkPinTask", {
        projectId: "p2",
        pinId,
        taskId: "TASK7",
      }),
    ).toEqual({ removed: false });
  });
});

describe("pin tasks: status", () => {
  it("shows card, threads, pull requests, merge state and unavailable threads", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    fake.tasks.tasks.get("TASK1")!.status = "in_review";
    fake.tasks.threads.set("TASK1", [
      {
        id: "L1",
        taskId: "TASK1",
        threadId: "thr_a",
        presetName: "Builder",
        title: "Build it",
        liveStatus: "working",
        attachedAt: "a",
        updatedAt: "a",
      },
    ]);
    fake.tasks.pullRequests.set("TASK1", {
      pullRequests: [
        {
          url: "https://github.com/o/r/pull/5",
          number: 5,
          title: "Add it",
          state: "merged",
          updatedAt: "a",
          threadIds: ["thr_a"],
        },
      ],
      unavailableThreadIds: ["thr_gone"],
    });
    expect(await pinTasks(fake)).toEqual([
      {
        pinId,
        taskId: "TASK1",
        key: "ONE-1",
        state: "found",
        message: null,
        title: "Decide the first question",
        status: "in_review",
        threads: [
          { threadId: "thr_a", title: "Build it", liveStatus: "working" },
        ],
        pullRequests: [
          {
            url: "https://github.com/o/r/pull/5",
            number: 5,
            title: "Add it",
            state: "merged",
          },
        ],
        unavailableThreadIds: ["thr_gone"],
      },
    ]);
  });

  it("shows card removed when the card no longer exists", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    fake.tasks.tasks.delete("TASK1");
    const [item] = await pinTasks(fake);
    expect(item).toMatchObject({
      pinId,
      taskId: "TASK1",
      key: "ONE-1",
      state: "removed",
      title: null,
      status: null,
      threads: [],
      pullRequests: [],
    });
  });

  it("resolves a re-keyed card by its stable id and shows the live key", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    fake.tasks.tasks.get("TASK1")!.key = "NEW-9";
    const [item] = await pinTasks(fake);
    expect(item).toMatchObject({ state: "found", key: "NEW-9" });
    expect(rows(fake)[0]?.task_key).toBe("ONE-1");
  });

  it("shows the tasks plugin failure instead of hiding the card", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    fake.tasks.failing.add("getTask");
    const [item] = await pinTasks(fake);
    expect(item).toMatchObject({
      pinId,
      key: "ONE-1",
      state: "unavailable",
      title: null,
      status: null,
    });
    expect(item?.message).toContain("tasks getTask failed");
  });

  it("keeps the card and says when threads or pull requests could not be read", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    fake.tasks.failing.add("listTaskPullRequests");
    const [item] = await pinTasks(fake);
    expect(item).toMatchObject({
      state: "found",
      status: "backlog",
      pullRequests: [],
    });
    expect(item?.message).toMatch(/pull requests/i);
  });

  it("shows only the key when the card moved to a board not linked to the project", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    fake.tasks.boards.push({
      id: "B2",
      name: "Elsewhere",
      prefix: "ELS",
      linked: "p2",
    });
    fake.tasks.tasks.get("TASK1")!.projectId = "B2";
    fake.tasks.threads.set("TASK1", [
      {
        id: "L1",
        taskId: "TASK1",
        threadId: "thr_a",
        presetName: "Builder",
        title: "Secret",
        liveStatus: "working",
        attachedAt: "a",
        updatedAt: "a",
      },
    ]);
    const [item] = await pinTasks(fake);
    expect(item).toMatchObject({
      pinId,
      key: "ONE-1",
      state: "unavailable",
      title: null,
      status: null,
      threads: [],
      pullRequests: [],
    });
    expect(item?.message).toMatch(/not linked to this project/);
    expect(called(fake, "listTaskThreads")).toEqual([]);
    expect(called(fake, "listTaskPullRequests")).toEqual([]);
  });

  it("shows only the key when the board is no longer linked to the project", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    fake.tasks.boards[0]!.linked = "p2";
    const [item] = await pinTasks(fake);
    expect(item).toMatchObject({ state: "unavailable", title: null });
    expect(called(fake, "listTaskThreads")).toEqual([]);
  });

  it("does not show the card when the boards cannot be listed", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    fake.tasks.failing.add("listProjects");
    const [item] = await pinTasks(fake);
    expect(item).toMatchObject({
      key: "ONE-1",
      state: "unavailable",
      title: null,
      threads: [],
    });
  });

  it("lists only the cards of pins in the requested project", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    expect(
      await fake.host.harness.callRpc("pinTasks", { projectId: "p2" }),
    ).toEqual([]);
  });
});

describe("pin tasks: freshness", () => {
  it("declares its own tag and invalidates it on every task change", async () => {
    const fake = await setup();
    fake.tasks.tasks.set("TASK7", {
      id: "TASK7",
      projectId: "B1",
      key: "ONE-7",
      title: "Existing",
      description: "",
      status: "todo",
    });
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    await linkTask(fake, pinId, "ONE-7");
    await fake.host.harness.callRpc("unlinkPinTask", {
      projectId: "p1",
      pinId,
      taskId: "TASK7",
    });
    await fake.host.harness.callRpc("deletePin", { projectId: "p1", pinId });
    const tags = fake.host.harness.experimental_rpcInvalidations.flat(2);
    expect(tags.filter((tag: unknown) => tag === TAG)).toHaveLength(4);
  });

  it("does not invalidate when nothing was linked", async () => {
    const tasks = newTasks();
    tasks.boards = [];
    const fake = await setup(tasks);
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    const tags = fake.host.harness.experimental_rpcInvalidations.flat(2);
    expect(tags.filter((tag: unknown) => tag === TAG)).toHaveLength(0);
  });
});

describe("pin tasks never edit the repository", () => {
  it("calls only read and create methods of the tasks plugin", async () => {
    const fake = await setup();
    const pinId = await createPin(fake);
    await makeTask(fake, pinId);
    await pinTasks(fake);
    const methods = new Set(fake.tasks.calls.map((call) => call.method));
    for (const method of methods) {
      expect([
        "listProjects",
        "createTask",
        "getTask",
        "getTaskByKey",
        "listTaskThreads",
        "listTaskPullRequests",
      ]).toContain(method);
    }
    expect(
      fake.host.harness.sdk.calls
        .map((call) => call.path)
        .filter((path) => /files\.(write|mkdir|move|remove)/.test(path)),
    ).toEqual([]);
  });
});
