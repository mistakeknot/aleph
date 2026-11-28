import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  allowlistEntrySha256,
  commitSecretValues,
  probeSecretDestination,
} from "./secret-commit.js";

async function destinationFixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "secret-destination-")),
  );
  const parent = path.join(root, "project");
  await fs.mkdir(parent, { mode: 0o700 });
  const destination = path.join(parent, ".env");
  const allowlistPath = path.join(root, "allowlist.json");
  const entry = {
    project: "fixture",
    path: destination,
    names: ["FIXTURE"],
    consumer: "fixture",
  };
  await fs.writeFile(allowlistPath, JSON.stringify({ entries: [entry] }), {
    mode: 0o600,
  });
  const uid = (await fs.stat(root)).uid;
  const config = {
    allowlistPath,
    allowlistOwnerUid: uid,
    homeDir: root,
    trustedUid: uid,
    now: Date.now,
  };
  const binding = {
    requestId: randomUUID(),
    threadId: "fixture-thread",
    hostId: "fixture-host",
    project: entry.project,
    path: destination,
    fields: [{ name: "FIXTURE", description: null }],
    purpose: null,
    expiresAtMs: Date.now() + 60_000,
  };
  const probe = await probeSecretDestination(
    { type: "host.secret_probe", ...binding },
    config,
  );
  if (probe.outcome !== "ready") {
    throw new Error(
      probe.outcome === "refused"
        ? probe.message
        : "Unexpected validation result",
    );
  }
  return { root, parent, destination, entry, config, binding, probe };
}

function checks(fixture: Awaited<ReturnType<typeof destinationFixture>>) {
  const { config, binding, probe } = fixture;
  const expectedDestination = {
    parent: probe.parent,
    allowlistEntrySha256: probe.allowlistEntrySha256,
  };
  return {
    open: () =>
      probeSecretDestination(
        { type: "host.secret_probe", ...binding, expectedDestination },
        config,
      ),
    write: () =>
      commitSecretValues(
        {
          type: "host.secret_commit",
          ...binding,
          ...expectedDestination,
          requestDigest: probe.requestDigest,
          file: probe.file,
          values: { FIXTURE: "synthetic-value" },
        },
        config,
      ),
  };
}

it("refuses a different directory identity at form open", async () => {
  const fixture = await destinationFixture();
  const other = await destinationFixture();
  expect(fixture.probe.parent).not.toEqual(other.probe.parent);
  fixture.probe.parent = other.probe.parent;
  expect(await checks(fixture).open()).toMatchObject({
    outcome: "refused",
    reason: "identity-changed",
  });
  expect(await fs.readdir(fixture.parent)).toEqual([]);
});

it("refuses a symlinked directory even when its target has the approved identity", async () => {
  const fixture = await destinationFixture();
  const alias = path.join(fixture.root, "alias");
  await fs.symlink(fixture.parent, alias);
  fixture.binding.path = path.join(alias, ".env");
  const entry = { ...fixture.entry, path: fixture.binding.path };
  await fs.writeFile(
    fixture.config.allowlistPath,
    JSON.stringify({ entries: [entry] }),
  );
  fixture.probe.allowlistEntrySha256 = allowlistEntrySha256(entry);
  expect(await checks(fixture).open()).toMatchObject({
    outcome: "refused",
    reason: "symlink-in-path",
  });
  expect(await fs.readdir(fixture.parent)).toEqual([]);
});

it.each([
  ["mode", "parent-ownership"],
  ["owner", "parent-ownership"],
  ["linked-worktree", "parent-git-repository"],
  ["bare-repository", "parent-git-repository"],
  ["allowlist", "not-allowlisted"],
] as const)(
  "refuses a changed %s at form open and write",
  async (change, reason) => {
    const fixture = await destinationFixture();
    if (change === "mode") await fs.chmod(fixture.parent, 0o1700);
    if (change === "owner") fixture.config.trustedUid += 1;
    if (change === "linked-worktree") {
      await fs.writeFile(path.join(fixture.root, ".git"), "gitdir: linked\n");
    }
    if (change === "bare-repository") {
      await fs.writeFile(
        path.join(fixture.parent, "HEAD"),
        "ref: refs/heads/main\n",
      );
      await fs.mkdir(path.join(fixture.parent, "objects"));
      await fs.mkdir(path.join(fixture.parent, "refs"));
    }
    if (change === "allowlist") {
      await fs.writeFile(fixture.config.allowlistPath, '{"entries":[]}');
    }
    const { open, write } = checks(fixture);
    for (const check of [open, write]) {
      expect(await check()).toMatchObject({ outcome: "refused", reason });
    }
    await expect(fs.stat(fixture.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("refuses a mount boundary even when the filesystem device is unchanged", async () => {
  const fixture = await destinationFixture();
  const readFile = fs.readFile.bind(fs);
  const mock = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    const name = args[0];
    if (typeof name === "string" && name.startsWith("/proc/self/fdinfo/")) {
      const fd = path.basename(name);
      if ((await fs.readlink(`/proc/self/fd/${fd}`)) === fixture.parent) {
        return "mnt_id:\t999999999\n";
      }
    }
    return readFile(...args);
  });
  try {
    const { open, write } = checks(fixture);
    for (const check of [open, write]) {
      expect(await check()).toMatchObject({
        outcome: "refused",
        reason: "parent-mount-point",
      });
    }
    expect(await fs.readdir(fixture.parent)).toEqual([]);
  } finally {
    mock.mockRestore();
  }
});

it("validates the recorded destination and writes the synthetic value", async () => {
  const fixture = await destinationFixture();
  const { open, write } = checks(fixture);
  expect(await open()).toEqual({ outcome: "validated" });
  expect(await write()).toMatchObject({ outcome: "written", added: 1 });
  expect(await fs.readFile(fixture.destination, "utf8")).toBe(
    "FIXTURE='synthetic-value'\n",
  );
  expect((await fs.stat(fixture.destination)).mode & 0o777).toBe(0o600);
});

it("rechecks folder mode after preparing the write", async () => {
  const fixture = await destinationFixture();
  const config = Object.assign(fixture.config, {
    afterStep: async (step: string) => {
      if (step === "target-read") await fs.chmod(fixture.parent, 0o750);
    },
  });
  expect(await checks({ ...fixture, config }).write()).toMatchObject({
    outcome: "refused",
    reason: "parent-ownership",
  });
  expect(await fs.readdir(fixture.parent)).toEqual([]);
});
