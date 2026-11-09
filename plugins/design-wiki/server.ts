import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  designWikiRpcContract,
  PIN_BODY_MAX,
  pinDecisionTag,
  pinTag,
  pinTaskTag,
  type AnswerPinDecisionResult,
  type Pin,
  type PinDecisionAnswer,
  type PinDecisionItem,
  type PinTaskItem,
  type PinTaskResult,
  type TaskBoard,
  type WikiPageResult,
  type WikiProject,
} from "./contract.js";
import { PIN_MIGRATIONS } from "./pin-migrations.js";
import {
  CARD_KEY_FOR_AUTARCH,
  autarchClient,
  type AutarchClient,
  type AutarchOwedAsk,
} from "./autarch-client.js";
import {
  claimMarkerFor,
  resolvePinAnchor,
  verifyClaimTarget,
  type ClaimTarget,
} from "./pin-anchor.js";
import {
  discoverWiki,
  WikiSourceRejectedError,
  type WikiDiscovery,
  type WikiFileSource,
} from "./wiki-discovery.js";
import { tasksClient, type TasksClient } from "./tasks-client.js";
import type { WikiList } from "./wiki-types.js";

function fail<R extends string>(reason: R) {
  return { ok: false as const, reason };
}

function succeed(pin: Pin) {
  return { ok: true as const, pin };
}

interface PinRow {
  id: string;
  project_id: string;
  page_id: string;
  source_path: string;
  claim_label: string | null;
  claim_context: string | null;
  claim_ordinal: number | null;
  claim_group_size: number | null;
  body: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface PinTaskRow {
  pin_id: string;
  task_id: string;
  task_key: string;
  task_project_id: string;
}

const TASK_TITLE_MAX = 120;

interface PinThreadRow {
  pin_id: string;
  thread_id: string;
}

const MAX_LISTED_FILES = 10_000;
const MAX_PAGE_BYTES = 512 * 1024;
const DISCOVERY_TTL_MS = 10_000;
const MISSING_PATH_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

interface CheckoutRoot {
  hostId: string;
  path: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return typeof error.code === "string" && MISSING_PATH_CODES.has(error.code);
}

interface PinCardKey {
  key: string;
  origin: PinDecisionItem["origin"];
}

type AnswerRead =
  | { answer: PinDecisionAnswer; reason: null }
  | { answer: null; reason: string };

const OPEN_THE_CARD = "Open the card to answer it.";

function readAnswer(owed: AutarchOwedAsk | undefined): AnswerRead {
  if (owed === undefined) {
    return {
      answer: null,
      reason: "This card is not waiting for a ruling in Citadel.",
    };
  }
  const { ask } = owed;
  const options = ask.options ?? [];
  if (
    ask.kind !== "decide" ||
    ask.questions !== undefined ||
    options.length === 0 ||
    options.some(
      (option) =>
        option.id === "" ||
        option.approval !== undefined ||
        option.approval === null,
    )
  ) {
    return {
      answer: null,
      reason: `This decision cannot be answered with one pick here. ${OPEN_THE_CARD}`,
    };
  }
  return {
    answer: {
      decisionId: owed.id,
      revision: owed.revision,
      question: ask.question ?? "",
      recommendation: ask.recommendation ?? null,
      options: options.map((option) => ({
        id: option.id,
        label: option.label,
      })),
    },
    reason: null,
  };
}

export default async function designWikiPlugin(bb: BbPluginApi): Promise<void> {
  const db = bb.storage.database();
  bb.storage.migrate(db, PIN_MIGRATIONS);

  function claimOf(row: PinRow): ClaimTarget | null {
    if (
      row.claim_label === null ||
      row.claim_context === null ||
      row.claim_ordinal === null ||
      row.claim_group_size === null
    ) {
      return null;
    }
    return {
      label: row.claim_label,
      context: row.claim_context,
      ordinal: row.claim_ordinal,
      groupSize: row.claim_group_size,
    };
  }

  function toPin(
    row: PinRow,
    threadIds: string[],
    discovery: WikiDiscovery,
  ): Pin {
    const claim = claimOf(row);
    return {
      id: row.id,
      projectId: row.project_id,
      pageId: row.page_id,
      sourcePath: row.source_path,
      claim,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      threadIds,
      anchor: resolvePinAnchor(
        { pageId: row.page_id, sourcePath: row.source_path, claim },
        discovery,
      ),
    };
  }

  function threadIdsOf(pinIds: string[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    if (pinIds.length === 0) return grouped;
    const rows = db
      .prepare(
        `SELECT pin_id, thread_id FROM pin_threads WHERE pin_id IN (${pinIds
          .map(() => "?")
          .join(",")}) ORDER BY linked_at, thread_id`,
      )
      .all(...pinIds) as PinThreadRow[];
    for (const row of rows) {
      const existing = grouped.get(row.pin_id) ?? [];
      existing.push(row.thread_id);
      grouped.set(row.pin_id, existing);
    }
    return grouped;
  }

  function invalidatePins(projectId: string): void {
    bb.rpc.experimental_invalidate([pinTag(projectId)]);
    bb.rpc.experimental_invalidate([pinDecisionTag(projectId)]);
  }

  function invalidatePinTasks(projectId: string): void {
    bb.rpc.experimental_invalidate([pinTaskTag(projectId)]);
    bb.rpc.experimental_invalidate([pinDecisionTag(projectId)]);
  }

  const tasks: TasksClient = tasksClient(bb);
  const autarch: AutarchClient = autarchClient(bb);

  function taskFailure(
    reason: Extract<PinTaskResult, { ok: false }>["reason"],
    message: string,
    extra: { boards?: TaskBoard[]; task?: { id: string; key: string } } = {},
  ): PinTaskResult {
    return { ok: false, reason, message, ...extra };
  }

  async function linkedBoards(projectId: string): Promise<TaskBoard[]> {
    const boards = await tasks.listBoards();
    return boards
      .filter((board) => board.linkedBbProjectId === projectId)
      .map((board) => ({
        id: board.id,
        name: board.name,
        prefix: board.prefix,
      }));
  }

  function cardTitle(body: string): string {
    const first =
      body
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? body;
    return first.slice(0, TASK_TITLE_MAX).trim();
  }

  function cardDescription(row: PinRow): string {
    const lines = [
      row.body,
      "",
      "---",
      `Design wiki pin: ${row.id}`,
      `Project: ${row.project_id}`,
      `Page: ${row.page_id}`,
    ];
    if (row.claim_label !== null) lines.push(`Claim: ${row.claim_label}`);
    lines.push(
      `[Open this pin's page in the design wiki](/plugins/bb--design-wiki/wiki/${row.project_id}/${row.page_id})`,
    );
    return lines.join("\n");
  }

  function recordTask(
    pinId: string,
    task: { id: string; key: string; projectId: string },
  ): boolean {
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO pin_tasks (pin_id, task_id, task_key, task_project_id, linked_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(pinId, task.id, task.key, task.projectId, new Date().toISOString());
    return result.changes > 0;
  }

  async function readPinTask(
    row: PinTaskRow,
    boardIds: Set<string> | null,
  ): Promise<PinTaskItem> {
    const base = {
      pinId: row.pin_id,
      taskId: row.task_id,
      key: row.task_key,
      title: null,
      status: null,
      threads: [],
      pullRequests: [],
      unavailableThreadIds: [],
    };
    let task: Awaited<ReturnType<TasksClient["getTask"]>>;
    try {
      task = await tasks.getTask(row.task_id);
    } catch (error) {
      return {
        ...base,
        state: "unavailable",
        message: `Could not read the card: ${errorMessage(error)}`,
      };
    }
    if (task === null) {
      return {
        ...base,
        state: "removed",
        message: "This card no longer exists on the task board.",
      };
    }
    if (boardIds === null) {
      return {
        ...base,
        state: "unavailable",
        message:
          "Could not check which task boards belong to this project, so the card is not shown.",
      };
    }
    if (!boardIds.has(task.projectId)) {
      return {
        ...base,
        state: "unavailable",
        message:
          "This card is now on a board that is not linked to this project, so its status is not shown.",
      };
    }
    const problems: string[] = [];
    const [threads, pullRequests] = await Promise.all([
      tasks.listThreads(task.id).catch((error: unknown) => {
        problems.push(`Could not read the threads: ${errorMessage(error)}`);
        return [];
      }),
      tasks.listPullRequests(task.id).catch((error: unknown) => {
        problems.push(
          `Could not read the pull requests: ${errorMessage(error)}`,
        );
        return { pullRequests: [], unavailableThreadIds: [] };
      }),
    ]);
    return {
      ...base,
      key: task.key,
      state: "found",
      message: problems.length === 0 ? null : problems.join(" "),
      title: task.title,
      status: task.status,
      threads: threads.map((thread) => ({
        threadId: thread.threadId,
        title: thread.title,
        liveStatus: thread.liveStatus,
      })),
      pullRequests: pullRequests.pullRequests.map((request) => ({
        url: request.url,
        number: request.number,
        title: request.title,
        state: request.state,
      })),
      unavailableThreadIds: pullRequests.unavailableThreadIds,
    };
  }

  function pinRow(projectId: string, pinId: string): PinRow | undefined {
    return db
      .prepare("SELECT * FROM pins WHERE id = ? AND project_id = ?")
      .get(pinId, projectId) as PinRow | undefined;
  }

  async function pinOf(row: PinRow): Promise<Pin> {
    const discovery = await discover(row.project_id);
    return toPin(row, threadIdsOf([row.id]).get(row.id) ?? [], discovery);
  }

  function cardKeysOf(row: PinRow, discovery: WikiDiscovery): PinCardKey[] {
    const found: PinCardKey[] = [];
    const claim = claimOf(row);
    const anchor = resolvePinAnchor(
      { pageId: row.page_id, sourcePath: row.source_path, claim },
      discovery,
    );
    const page = discovery.pages.find((item) => item.id === row.page_id);
    if (page !== undefined && anchor.state === "claim" && claim !== null) {
      for (const key of claimMarkerFor(page, claim)?.cards ?? []) {
        found.push({ key, origin: "claim" });
      }
    } else if (page !== undefined && anchor.state === "page") {
      if (page.card !== null) found.push({ key: page.card, origin: "page" });
    }
    const recorded = db
      .prepare("SELECT task_key FROM pin_tasks WHERE pin_id = ? ORDER BY rowid")
      .all(row.id) as { task_key: string }[];
    for (const task of recorded) {
      found.push({ key: task.task_key, origin: "task" });
    }
    return found.filter(
      (entry, index) =>
        found.findIndex((other) => other.key === entry.key) === index,
    );
  }

  async function readOwed(): Promise<AutarchOwedAsk[] | null> {
    try {
      return await autarch.owed();
    } catch {
      return null;
    }
  }

  type CardRead =
    | { found: "unavailable" }
    | { found: false }
    | { found: true; state: string; title: string };

  async function readCard(key: string): Promise<CardRead> {
    if (!CARD_KEY_FOR_AUTARCH.test(key)) return { found: false };
    try {
      const card = await autarch.cardState(key);
      return card.found
        ? { found: true, state: card.state, title: card.title }
        : { found: false };
    } catch {
      return { found: "unavailable" };
    }
  }

  function cleanBody(raw: string): string | null {
    const body = raw.trim();
    return body.length === 0 || body.length > PIN_BODY_MAX ? null : body;
  }

  async function checkoutRoot(projectId: string): Promise<CheckoutRoot | null> {
    const project = await bb.sdk.projects.get({ projectId });
    const source =
      project.sources.find((candidate) => candidate.isDefault) ??
      project.sources[0];
    return source === undefined
      ? null
      : { hostId: source.hostId, path: source.path };
  }

  function fileSource(root: CheckoutRoot): WikiFileSource {
    return {
      async listMarkdownFiles(directory) {
        const absolute = `${root.path}/${directory}`;
        let result: Awaited<
          ReturnType<BbPluginApi["sdk"]["files"]["listPaths"]>
        >;
        try {
          result = await bb.sdk.files.listPaths({
            hostId: root.hostId,
            path: absolute,
            includeFiles: true,
            includeDirectories: false,
            includeHidden: false,
            limit: MAX_LISTED_FILES,
          });
        } catch (error) {
          if (isMissingPath(error)) return null;
          throw error;
        }
        if (result.truncated) {
          throw new WikiSourceRejectedError(
            `${directory} holds more than ${MAX_LISTED_FILES} entries, so the listing is incomplete`,
          );
        }
        const names: string[] = [];
        for (const entry of result.paths) {
          if (entry.kind !== "file") continue;
          const relative = entry.path.startsWith(`${absolute}/`)
            ? entry.path.slice(absolute.length + 1)
            : entry.path;
          if (relative.includes("/") || !relative.endsWith(".md")) continue;
          names.push(relative);
        }
        return names;
      },
      async readText(path) {
        const file = await bb.sdk.files.read({
          hostId: root.hostId,
          path: `${root.path}/${path}`,
          rootPath: root.path,
        });
        if (file.contentEncoding !== "utf8") {
          throw new WikiSourceRejectedError("The page is not a text file");
        }
        if (file.sizeBytes > MAX_PAGE_BYTES) {
          throw new WikiSourceRejectedError("The page is larger than 512 KB");
        }
        return file.content;
      },
    };
  }

  interface DiscoveryEntry {
    startedAt: number;
    settled: boolean;
    result: Promise<WikiDiscovery>;
  }
  const discoveries = new Map<string, DiscoveryEntry>();

  function discover(
    projectId: string,
    options: { maxAgeMs?: number; fresh?: boolean } = {},
  ): Promise<WikiDiscovery> {
    const now = Date.now();
    const cached = discoveries.get(projectId);
    if (
      options.fresh !== true &&
      cached !== undefined &&
      (!cached.settled || now - cached.startedAt < (options.maxAgeMs ?? 0))
    ) {
      return cached.result;
    }
    for (const [key, candidate] of discoveries) {
      if (candidate.settled && now - candidate.startedAt >= DISCOVERY_TTL_MS) {
        discoveries.delete(key);
      }
    }
    const entry: DiscoveryEntry = {
      startedAt: now,
      settled: false,
      result: discoverUncached(projectId),
    };
    discoveries.set(projectId, entry);
    void entry.result.then((discovery) => {
      entry.settled = true;
      if (
        discovery.incomplete === true &&
        discoveries.get(projectId) === entry
      ) {
        discoveries.delete(projectId);
      }
    });
    return entry.result;
  }

  async function discoverUncached(projectId: string): Promise<WikiDiscovery> {
    let root: CheckoutRoot | null;
    try {
      root = await checkoutRoot(projectId);
    } catch (error) {
      return unavailable(`Could not open the project: ${errorMessage(error)}`);
    }
    if (root === null) {
      return unavailable("This project has no checkout on any host.");
    }
    try {
      return await discoverWiki(fileSource(root));
    } catch (error) {
      bb.log.warn(`design wiki discovery failed: ${errorMessage(error)}`);
      return unavailable(`Could not read the wiki: ${errorMessage(error)}`);
    }
  }

  function unavailable(message: string): WikiDiscovery {
    const list: WikiList = {
      state: "unavailable",
      message,
      pages: [],
      errors: [],
    };
    return { list, pages: [], incomplete: true };
  }

  bb.rpc.register(
    designWikiRpcContract,
    {
      async projects(): Promise<WikiProject[]> {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        return projects.map((project) => ({
          id: project.id,
          name: project.name,
          hasCheckout: project.sources.length > 0,
        }));
      },
      async list({ projectId }) {
        return (await discover(projectId, { maxAgeMs: DISCOVERY_TTL_MS })).list;
      },
      async page({ projectId, pageId }): Promise<WikiPageResult> {
        const found = (
          await discover(projectId, { maxAgeMs: DISCOVERY_TTL_MS })
        ).pages.find((page) => page.id === pageId);
        return found === undefined
          ? { state: "missing" }
          : { state: "found", page: found };
      },
      async pins({ projectId }) {
        const rows = db
          .prepare(
            "SELECT * FROM pins WHERE project_id = ? ORDER BY created_at, id",
          )
          .all(projectId) as PinRow[];
        if (rows.length === 0) return [];
        const discovery = await discover(projectId);
        const threads = threadIdsOf(rows.map((row) => row.id));
        return rows.map((row) =>
          toPin(row, threads.get(row.id) ?? [], discovery),
        );
      },
      async createPin({ projectId, pageId, claim, body }) {
        const text = cleanBody(body);
        if (text === null) return fail("invalid-body");
        const discovery = await discover(projectId, { fresh: true });
        const anchor = resolvePinAnchor(
          { pageId, sourcePath: "", claim: null },
          discovery,
        );
        if (anchor.state === "unverified") {
          return fail("unverified");
        }
        const found = discovery.pages.find(
          (candidate) => candidate.id === pageId,
        );
        if (anchor.state !== "page" || found === undefined) {
          return fail("page-missing");
        }
        if (claim !== null) {
          const verdict = verifyClaimTarget(found, claim);
          if (!verdict.ok) return fail(verdict.reason);
        }
        const now = new Date().toISOString();
        const id = randomUUID();
        db.prepare(
          `INSERT INTO pins (id, project_id, page_id, source_path, claim_label, claim_context, claim_ordinal, claim_group_size, body, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          projectId,
          pageId,
          found.path,
          claim?.label ?? null,
          claim?.context ?? null,
          claim?.ordinal ?? null,
          claim?.groupSize ?? null,
          text,
          now,
          now,
        );
        invalidatePins(projectId);
        const row = pinRow(projectId, id);
        if (row === undefined) return fail("page-missing");
        return succeed(toPin(row, [], discovery));
      },
      async updatePin({ projectId, pinId, body, resolved }) {
        const existing = pinRow(projectId, pinId);
        if (existing === undefined) return fail("not-found");
        let text = existing.body;
        if (body !== undefined) {
          const cleaned = cleanBody(body);
          if (cleaned === null) return fail("invalid-body");
          text = cleaned;
        }
        const now = new Date().toISOString();
        const resolvedAt =
          resolved === undefined
            ? existing.resolved_at
            : resolved
              ? (existing.resolved_at ?? now)
              : null;
        db.prepare(
          "UPDATE pins SET body = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
        ).run(text, resolvedAt, now, pinId, projectId);
        invalidatePins(projectId);
        const row = pinRow(projectId, pinId);
        if (row === undefined) return fail("not-found");
        return succeed(await pinOf(row));
      },
      async deletePin({ projectId, pinId }) {
        const result = db
          .prepare("DELETE FROM pins WHERE id = ? AND project_id = ?")
          .run(pinId, projectId);
        if (result.changes === 0) return { deleted: false };
        invalidatePins(projectId);
        invalidatePinTasks(projectId);
        return { deleted: true };
      },
      async linkPinThread({ projectId, pinId, threadId }) {
        if (pinRow(projectId, pinId) === undefined) {
          return fail("not-found");
        }
        let thread: { projectId?: string };
        try {
          thread = (await bb.sdk.threads.get({ threadId })) as {
            projectId?: string;
          };
        } catch {
          return fail("thread-not-found");
        }
        if (thread.projectId !== projectId) {
          return fail("wrong-project");
        }
        db.prepare(
          "INSERT OR IGNORE INTO pin_threads (pin_id, thread_id, linked_at) VALUES (?, ?, ?)",
        ).run(pinId, threadId, new Date().toISOString());
        invalidatePins(projectId);
        const row = pinRow(projectId, pinId);
        if (row === undefined) return fail("not-found");
        return succeed(await pinOf(row));
      },
      async createPinTask({
        projectId,
        pinId,
        taskProjectId,
      }): Promise<PinTaskResult> {
        const row = pinRow(projectId, pinId);
        if (row === undefined) {
          return taskFailure("not-found", "This pin no longer exists.");
        }
        let boards: TaskBoard[];
        try {
          boards = await linkedBoards(projectId);
        } catch (error) {
          return taskFailure(
            "tasks-unavailable",
            `Could not reach the tasks plugin: ${errorMessage(error)}`,
          );
        }
        let board: TaskBoard | undefined;
        if (taskProjectId !== undefined) {
          board = boards.find((candidate) => candidate.id === taskProjectId);
          if (board === undefined) {
            return taskFailure(
              "wrong-board",
              "That board is not linked to this project.",
              { boards },
            );
          }
        } else if (boards.length === 0) {
          return taskFailure(
            "no-board",
            "No task board is linked to this project. Link a board to the project in the tasks plugin, then try again.",
            { boards },
          );
        } else if (boards.length > 1) {
          return taskFailure(
            "board-required",
            "Several task boards are linked to this project. Choose one.",
            { boards },
          );
        } else {
          board = boards[0];
        }
        if (board === undefined) {
          return taskFailure("no-board", "No task board is linked.", {
            boards,
          });
        }
        let created: Awaited<ReturnType<TasksClient["createTask"]>>;
        try {
          created = await tasks.createTask({
            projectId: board.id,
            title: cardTitle(row.body),
            description: cardDescription(row),
          });
        } catch (error) {
          return taskFailure(
            "tasks-unavailable",
            `Could not create the card: ${errorMessage(error)}`,
          );
        }
        if (!created.ok) {
          return taskFailure(
            "tasks-refused",
            `The tasks plugin refused the card: ${created.error.message}`,
          );
        }
        const task = { id: created.task.id, key: created.task.key };
        try {
          recordTask(pinId, { ...task, projectId: created.task.projectId });
        } catch (error) {
          return taskFailure(
            "not-linked",
            `Card ${task.key} was created, but recording it on the pin failed: ${errorMessage(error)}. Use Link existing card with ${task.key}.`,
            { task },
          );
        }
        invalidatePinTasks(projectId);
        return { ok: true, task };
      },
      async linkPinTask({ projectId, pinId, taskKey }): Promise<PinTaskResult> {
        if (pinRow(projectId, pinId) === undefined) {
          return taskFailure("not-found", "This pin no longer exists.");
        }
        let found: Awaited<ReturnType<TasksClient["getTaskByKey"]>>;
        let boards: TaskBoard[];
        try {
          found = await tasks.getTaskByKey(taskKey);
          boards = await linkedBoards(projectId);
        } catch (error) {
          return taskFailure(
            "tasks-unavailable",
            `Could not reach the tasks plugin: ${errorMessage(error)}`,
          );
        }
        if (found === null) {
          return taskFailure(
            "task-not-found",
            `No card has the key ${taskKey}.`,
          );
        }
        if (!boards.some((board) => board.id === found.projectId)) {
          return taskFailure(
            "wrong-board",
            `Card ${found.key} is not on a board linked to this project.`,
            { boards },
          );
        }
        if (recordTask(pinId, found)) invalidatePinTasks(projectId);
        return { ok: true, task: { id: found.id, key: found.key } };
      },
      async unlinkPinTask({ projectId, pinId, taskId }) {
        if (pinRow(projectId, pinId) === undefined) return { removed: false };
        const result = db
          .prepare("DELETE FROM pin_tasks WHERE pin_id = ? AND task_id = ?")
          .run(pinId, taskId);
        if (result.changes === 0) return { removed: false };
        invalidatePinTasks(projectId);
        return { removed: true };
      },
      async pinDecisions({ projectId }): Promise<PinDecisionItem[]> {
        const rows = db
          .prepare(
            "SELECT * FROM pins WHERE project_id = ? ORDER BY created_at, id",
          )
          .all(projectId) as PinRow[];
        if (rows.length === 0) return [];
        const discovery = await discover(projectId);
        const wanted = rows.flatMap((row) =>
          cardKeysOf(row, discovery).map((entry) => ({
            pinId: row.id,
            ...entry,
          })),
        );
        if (wanted.length === 0) return [];
        const keys = [...new Set(wanted.map((entry) => entry.key))];
        const reads = new Map<string, CardRead>(
          await Promise.all(
            keys.map(async (key) => [key, await readCard(key)] as const),
          ),
        );
        const anyOpen = [...reads.values()].some(
          (read) => read.found === true && read.state === "open",
        );
        const owed = anyOpen ? await readOwed() : [];
        return wanted.map((entry): PinDecisionItem => {
          const read = reads.get(entry.key) ?? { found: false as const };
          const base = {
            pinId: entry.pinId,
            key: entry.key,
            origin: entry.origin,
          };
          if (read.found === "unavailable") {
            return {
              ...base,
              state: "unavailable",
              cardState: null,
              title: null,
              answer: null,
              reason: "Could not reach Citadel to read this card.",
            };
          }
          if (read.found === false) {
            return {
              ...base,
              state: "missing",
              cardState: null,
              title: null,
              answer: null,
              reason: "Citadel has no card with this key.",
            };
          }
          const title = read.title === "" ? null : read.title;
          if (read.state !== "open") {
            return {
              ...base,
              state: "closed",
              cardState: read.state,
              title,
              answer: null,
              reason: null,
            };
          }
          if (owed === null) {
            return {
              ...base,
              state: "open",
              cardState: read.state,
              title,
              answer: null,
              reason: "Could not reach Citadel to read this decision.",
            };
          }
          const result = readAnswer(
            owed.find((item) => item.key === entry.key),
          );
          return {
            ...base,
            state: "open",
            cardState: read.state,
            title,
            ...result,
          };
        });
      },
      async answerPinDecision({
        projectId,
        pinId,
        key,
        optionId,
        revision,
        pickId,
      }): Promise<AnswerPinDecisionResult> {
        const refuse = (
          reason: Extract<AnswerPinDecisionResult, { ok: false }>["reason"],
          message: string,
        ): AnswerPinDecisionResult => ({ ok: false, reason, message });
        if (!CARD_KEY_FOR_AUTARCH.test(key)) {
          return refuse("not-linked", `${key} is not a card key.`);
        }
        const row = pinRow(projectId, pinId);
        if (row === undefined) {
          return refuse("not-found", "This pin no longer exists.");
        }
        const linked = cardKeysOf(
          row,
          await discover(projectId, { fresh: true }),
        );
        if (!linked.some((entry) => entry.key === key)) {
          return refuse("not-linked", `${key} is not a card on this pin.`);
        }
        const owed = await readOwed();
        if (owed === null) {
          return refuse(
            "unavailable",
            "Could not reach Citadel. Nothing was answered.",
          );
        }
        const found = owed.find((item) => item.key === key);
        if (found === undefined) {
          return refuse(
            "not-open",
            `${key} is not waiting for a ruling in Citadel any more.`,
          );
        }
        const read = readAnswer(found);
        if (
          read.answer === null ||
          !read.answer.options.some((option) => option.id === optionId)
        ) {
          return refuse(
            "not-answerable",
            `That cannot be answered with one pick here. ${OPEN_THE_CARD}`,
          );
        }
        let picked: Awaited<ReturnType<AutarchClient["pick"]>>;
        try {
          picked = await autarch.pick({
            decisionId: read.answer.decisionId,
            optionId,
            revision,
            pickId,
          });
        } catch (error) {
          invalidatePinTasks(projectId);
          return refuse(
            "unknown",
            `Could not confirm whether Citadel took the answer (${errorMessage(error)}). Check the card before answering again.`,
          );
        }
        invalidatePinTasks(projectId);
        if (picked.ok) return { ok: true };
        if (picked.status === 409) {
          return refuse(
            "stale",
            "This decision changed while you were looking at it. The latest version is shown now; check it and answer again.",
          );
        }
        return refuse(
          "refused",
          `Citadel did not take the answer: ${picked.error ?? "no reason given"}.`,
        );
      },
      async pinTasks({ projectId }) {
        const rows = db
          .prepare(
            `SELECT pt.pin_id, pt.task_id, pt.task_key, pt.task_project_id
             FROM pin_tasks pt JOIN pins p ON p.id = pt.pin_id
             WHERE p.project_id = ?
             ORDER BY p.created_at, p.id, pt.rowid`,
          )
          .all(projectId) as PinTaskRow[];
        if (rows.length === 0) return [];
        const boardIds = await linkedBoards(projectId).then(
          (boards) => new Set(boards.map((board) => board.id)),
          () => null,
        );
        return Promise.all(rows.map((row) => readPinTask(row, boardIds)));
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Project design wiki: CUJ and requirement pages kept in the project's repository, read-only, plus pins (sticky notes on a page or claim). Pins live in plugin storage and never change a repository file; the only other write is a card created on the project's task board when a pin is made into a task.",
    },
  );
}
