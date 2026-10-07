import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runServer: vi.fn(async () => {}),
}));

vi.mock("@bb/config/server", () => ({
  loadServerConfig: () => ({ BB_DATA_DIR: "/nonexistent-aleph-entry" }),
}));
vi.mock("@bb/process-utils", () => ({
  installSafeProcessDiagnostics: () => {},
  writeSafeProcessDiagnosticReport: () => {},
}));
vi.mock("../../src/start-server.js", () => ({ runServer: mocks.runServer }));

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aleph-entry-"));
  mocks.runServer.mockClear();
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { force: true, recursive: true });
});

describe("server entrypoint", () => {
  it("hands the environment-configured notice command to the server", async () => {
    vi.stubEnv(
      "ALEPH_UPDATE_NOTIFY_COMMAND",
      JSON.stringify([
        process.execPath,
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[1],d))",
        join(dir, "out"),
      ]),
    );
    await import("../../src/index.js");
    await vi.waitFor(() => expect(mocks.runServer).toHaveBeenCalled());
    const calls = mocks.runServer.mock.calls as unknown as Array<
      [unknown, { alephUpdateNotify?: (message: string) => Promise<void> }]
    >;
    const options = calls[0]?.[1];
    expect(typeof options?.alephUpdateNotify).toBe("function");
    await options?.alephUpdateNotify?.("Aleph update request n: started");
    expect(await readFile(join(dir, "out"), "utf8")).toBe(
      "Aleph update request n: started",
    );
  });
});
