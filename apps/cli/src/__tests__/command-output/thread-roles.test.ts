import { describe, expect, it, vi } from "vitest";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import {
  collectLogLines,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

const held = {
  role: "ruler",
  threadId: "thr_ruler1",
  title: "Masaq'  |\tvizier　one",
  archived: false,
  generation: 7,
  since: Date.UTC(2026, 10, 14, 12),
};

const unheld = {
  role: "channel",
  threadId: null,
  title: null,
  archived: null,
  generation: 3,
  since: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stderrLines(): string[] {
  return vi.mocked(console.error).mock.calls.map((args) => args.join(" "));
}

describe("bb thread role command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  function stubRoles(handlers: Record<string, () => unknown>): void {
    stubServerApi(
      Object.fromEntries(
        Object.entries(handlers).map(([path, handler]) => [
          `v1.thread-roles.${path}`,
          async () => handler() as never,
        ]),
      ),
    );
  }

  it("prints a held role as one line and exits 0", async () => {
    stubRoles({ ":role.$get": () => held });

    await runCommand(["thread", "role", "get", "ruler"], register);

    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      `ruler thr_ruler1 ${JSON.stringify(held.title)} generation 7 since 2026-11-14T12:00:00.000Z`,
    ]);
    expect(stderrLines()).toEqual([]);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("marks an archived holder and still exits 0", async () => {
    stubRoles({ ":role.$get": () => ({ ...held, archived: true }) });

    await runCommand(["thread", "role", "get", "ruler"], register);

    expect(collectLogLines(vi.mocked(console.log))[0]).toMatch(
      / \(archived\)$/,
    );
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("prints the held JSON body unchanged", async () => {
    stubRoles({ ":role.$get": () => held });

    await runCommand(["thread", "role", "get", "ruler", "--json"], register);

    expect(console.log).toHaveBeenCalledWith(JSON.stringify(held, null, 2));
  });

  it("exits 3 with one stderr line and no stdout for an unheld role", async () => {
    stubRoles({ ":role.$get": () => unheld });

    await expect(
      runCommand(["thread", "role", "get", "channel"], register),
    ).rejects.toThrow("process.exit:3");

    expect(console.log).not.toHaveBeenCalled();
    expect(stderrLines()).toEqual(["No thread holds role channel."]);
  });

  it("exits 3 with the body on stdout and one stderr line under --json", async () => {
    stubRoles({ ":role.$get": () => unheld });

    await expect(
      runCommand(["thread", "role", "get", "channel", "--json"], register),
    ).rejects.toThrow("process.exit:3");

    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      JSON.stringify(unheld, null, 2),
    ]);
    expect(stderrLines()).toEqual(["No thread holds role channel."]);
  });

  it("exits 1 when an older server answers 404", async () => {
    stubRoles({
      ":role.$get": () =>
        jsonResponse(404, { code: "not_found", message: "Not found" }),
    });

    await expect(
      runCommand(["thread", "role", "get", "ruler"], register),
    ).rejects.toThrow("process.exit:1");

    expect(stderrLines()[0]).toMatch(/^Error: /);
  });

  it("exits 1 when the body does not match the schema", async () => {
    stubRoles({ ":role.$get": () => ({ role: "ruler" }) });

    await expect(
      runCommand(["thread", "role", "get", "ruler"], register),
    ).rejects.toThrow("process.exit:1");
  });

  it("rejects a bad role name before any request", async () => {
    const get = vi.fn(async () => held);
    stubServerApi({ "v1.thread-roles.:role.$get": get });

    await expect(
      runCommand(["thread", "role", "get", "Not_A_Role"], register),
    ).rejects.toThrow("process.exit:1");

    expect(get).not.toHaveBeenCalled();
  });

  it("lists every role as wrapped JSON", async () => {
    const body = { roles: [held, unheld] };
    stubRoles({ "$get": () => body });

    await runCommand(["thread", "role", "list", "--json"], register);

    expect(console.log).toHaveBeenCalledWith(JSON.stringify(body, null, 2));
  });

  it("lists unheld roles without a holder", async () => {
    stubRoles({ "$get": () => ({ roles: [unheld] }) });

    await runCommand(["thread", "role", "list"], register);

    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "channel (no holder) generation 3",
    ]);
  });

  it("sends the expected generation on transfer", async () => {
    const transfer = vi.fn(async () => ({ ...held, generation: 8 }));
    stubServerApi({ "v1.thread-roles.:role.transfer.$post": transfer });

    await runCommand(
      [
        "thread",
        "role",
        "transfer",
        "ruler",
        "--to",
        "thr_next",
        "--expect-generation",
        "7",
        "--json",
      ],
      register,
    );

    expect(transfer).toHaveBeenCalledWith({
      param: { role: "ruler" },
      json: { toThreadId: "thr_next", expectGeneration: 7 },
    });
  });

  it("rejects a bad --expect-generation before any request", async () => {
    const release = vi.fn(async () => unheld);
    stubServerApi({ "v1.thread-roles.:role.release.$post": release });

    for (const value of ["-1", "1.5", "abc", ""]) {
      await expect(
        runCommand(
          ["thread", "role", "release", "ruler", "--expect-generation", value],
          register,
        ),
      ).rejects.toThrow("process.exit:1");
    }

    expect(release).not.toHaveBeenCalled();
  });

  it("shows the current holder on a generation conflict", async () => {
    stubRoles({
      ":role.release.$post": () =>
        jsonResponse(409, {
          code: "role_generation_conflict",
          message: "Role generation moved",
          details: { current: { ...held, generation: 9 } },
        }),
    });

    await expect(
      runCommand(
        ["thread", "role", "release", "ruler", "--expect-generation", "7"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    const lines = stderrLines();
    expect(lines[0]).toBe("Error: HTTP 409: Role generation moved");
    expect(lines[1]).toBe(
      `Current: ruler thr_ruler1 ${JSON.stringify(held.title)} generation 9 since 2026-11-14T12:00:00.000Z`,
    );
    expect(console.log).not.toHaveBeenCalled();
  });

  it("puts conflict details in the JSON error envelope", async () => {
    const current = { ...held, generation: 9 };
    stubRoles({
      ":role.release.$post": () =>
        jsonResponse(409, {
          code: "role_generation_conflict",
          message: "Role generation moved",
          details: { current },
        }),
    });

    await expect(
      runCommand(
        [
          "thread",
          "role",
          "release",
          "ruler",
          "--expect-generation",
          "7",
          "--json",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      JSON.stringify(
        {
          ok: false,
          error: {
            code: "role_generation_conflict",
            message: "HTTP 409: Role generation moved",
            details: { current },
          },
        },
        null,
        2,
      ),
    ]);
  });

  it("omits details that do not match the schema", async () => {
    stubRoles({
      ":role.release.$post": () =>
        jsonResponse(409, {
          code: "role_generation_conflict",
          message: "Role generation moved",
          details: { current: { nonsense: true } },
        }),
    });

    await expect(
      runCommand(
        [
          "thread",
          "role",
          "release",
          "ruler",
          "--expect-generation",
          "7",
          "--json",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    const envelope = JSON.parse(
      String(vi.mocked(console.log).mock.calls[0]?.[0]),
    );
    expect(envelope.error.details).toBeUndefined();
  });

  it("claims a role for the target thread with update --role", async () => {
    const claim = vi.fn(async () => held);
    stubServerApi({ "v1.thread-roles.:role.claim.$post": claim });

    await runCommand(
      ["thread", "update", "thr_ruler1", "--role", "ruler"],
      register,
    );

    expect(claim).toHaveBeenCalledWith({
      param: { role: "ruler" },
      json: { threadId: "thr_ruler1" },
    });
  });

  it("claims for the current thread with update --self --role", async () => {
    vi.stubEnv("BB_THREAD_ID", "thr_self");
    const claim = vi.fn(async () => ({ ...held, threadId: "thr_self" }));
    stubServerApi({ "v1.thread-roles.:role.claim.$post": claim });

    await runCommand(["thread", "update", "--self", "--role", "ruler"], register);

    expect(claim).toHaveBeenCalledWith({
      param: { role: "ruler" },
      json: { threadId: "thr_self" },
    });
  });

  it("refuses --role beside other update flags", async () => {
    const claim = vi.fn(async () => held);
    stubServerApi({ "v1.thread-roles.:role.claim.$post": claim });

    await expect(
      runCommand(
        ["thread", "update", "thr_ruler1", "--role", "ruler", "--title", "x"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(claim).not.toHaveBeenCalled();
  });

  it("shows the live holder when the role is already held", async () => {
    stubRoles({
      ":role.claim.$post": () =>
        jsonResponse(409, {
          code: "role_held",
          message: "Role is held",
          details: { current: held },
        }),
    });

    await expect(
      runCommand(["thread", "update", "thr_other", "--role", "ruler"], register),
    ).rejects.toThrow("process.exit:1");

    expect(stderrLines()[1]).toMatch(/^Current: ruler thr_ruler1 /);
  });
});
