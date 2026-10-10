import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  launcherToServerMessageSchema,
  type LauncherToServerMessage,
  type SourceAppRevision,
} from "@bb/config/app-update";
import {
  createLauncherAppUpdateController,
  type LauncherServerPort,
} from "../src/app-update/launcher-controller.js";
import type { RunCommand } from "../src/app-update/run-command.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

class FakeServerPort extends EventEmitter implements LauncherServerPort {
  connected = true;
  readonly sent: LauncherToServerMessage[] = [];

  send(
    message: LauncherToServerMessage,
    callback: (error: Error | null) => void,
  ): boolean {
    this.sent.push(launcherToServerMessageSchema.parse(message));
    callback(null);
    return true;
  }

  request(requestId: string, request: unknown): void {
    this.emit("message", {
      channel: "bb-app-update/request",
      request,
      requestId,
    });
  }

  async response(requestId: string) {
    await vi.waitFor(() => {
      expect(
        this.sent.some(
          (message) =>
            message.channel === "bb-app-update/response" &&
            message.requestId === requestId,
        ),
      ).toBe(true);
    });
    return this.sent.find(
      (message) =>
        message.channel === "bb-app-update/response" &&
        message.requestId === requestId,
    );
  }
}

function setUp(version: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-app-update-aleph-"));
  scratchDirs.push(dataDir);
  const commands: string[][] = [];
  const runner: RunCommand = async (command) => {
    commands.push([command.command, ...command.args]);
    return { code: 1, outputTail: [], signal: null, stdout: "" };
  };
  const current: SourceAppRevision = {
    commit: "a".repeat(40),
    kind: "source",
    version,
  };
  const controller = createLauncherAppUpdateController({
    current,
    dataDir,
    log: () => undefined,
    mode: "source",
    repoRoot: join(dataDir, "checkout"),
    requestShutdown: () => undefined,
    restartNoticeMs: 0,
    runner,
  });
  const port = new FakeServerPort();
  controller.attachServer(port);
  return { commands, port };
}

describe("launcher source updates on an Aleph build", () => {
  it("refuses an apply request without touching the checkout", async () => {
    const { commands, port } = setUp("0.43.4+aleph.2");

    port.request("r1", {
      target: { commit: "b".repeat(40), kind: "source" },
      targetVersion: "0.44.0",
      type: "apply",
    });

    expect(await port.response("r1")).toMatchObject({
      error: expect.stringContaining("Aleph"),
    });
    expect(commands).toEqual([]);
  });

  it("refuses a source check without touching the checkout", async () => {
    const { commands, port } = setUp("0.43.4+aleph.2");

    port.request("r1", { type: "check-source" });

    expect(await port.response("r1")).toMatchObject({
      error: expect.stringContaining("Aleph"),
    });
    expect(commands).toEqual([]);
  });

  it("still inspects the checkout on a build that is not Aleph", async () => {
    const { commands, port } = setUp("0.43.4");

    port.request("r1", { type: "check-source" });
    await port.response("r1");

    expect(commands.length).toBeGreaterThan(0);
  });
});
