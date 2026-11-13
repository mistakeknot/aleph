import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { hosts, openSession } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonConnectAnnotationsRequestSchema,
} from "@bb/host-daemon-contract";
import { registerInternalConnectAnnotationRoutes } from "../../src/internal/connect-annotations.js";
import { setAuthenticatedDaemon } from "../../src/internal/auth.js";
import { ApiError } from "../../src/errors.js";
import type { PluginService } from "../../src/services/plugins/plugin-service.js";

it("binds storage addressing to the authenticated active host session", async () => {
  const db = createMigratedConnection();
  try {
    for (const id of ["host-a", "host-b"])
      db.insert(hosts)
        .values({
          id,
          name: id,
          type: "persistent",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
    const session = openSession(db, {
      hostId: "host-a",
      hostName: "Host",
      instanceId: "instance",
      dataDir: "/tmp/test-host",
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      heartbeatIntervalMs: 5000,
      leaseTimeoutMs: 30000,
    });
    let authenticatedHost = "host-a";
    const invoke = vi.fn<PluginService["invokeRpcHandler"]>(async () => ({
      ok: true,
      result: [],
    }));
    const plugins = {
      list: () => [{ id: "connect", source: "builtin:connect" }],
      getRpcHandler: () => ({ outcome: "found", owner: {}, value: {} }),
      invokeRpcHandler: invoke,
    } as unknown as Pick<
      PluginService,
      "list" | "getRpcHandler" | "invokeRpcHandler"
    >;
    const app = new Hono();
    app.onError((error, context) =>
      context.json(
        { error: error.message },
        error instanceof ApiError ? error.status : 400,
      ),
    );
    app.use("*", async (context, next) => {
      setAuthenticatedDaemon(context, {
        hostId: authenticatedHost,
        keyId: "key",
      });
      await next();
    });
    registerInternalConnectAnnotationRoutes(app, { db }, plugins);
    const payload = {
      sessionId: session.id,
      port: 3000,
      url: "https://machine--3000.example.test/page",
    };
    const request = (body: unknown) =>
      app.request("/session/connect-annotations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await request(payload)).status).toBe(200);
    expect(invoke.mock.calls[0]?.[3]).toEqual({
      hostId: "host-a",
      port: payload.port,
      url: payload.url,
    });
    expect(
      (
        await request({
          ...payload,
          change: { type: "annotation-delete", id: "note" },
        })
      ).status,
    ).toBe(200);
    expect(invoke.mock.calls[1]?.[1]).toBe(
      "connect.experimental_annotations.change",
    );
    authenticatedHost = "host-b";
    expect((await request(payload)).status).toBe(403);
    expect((await request({ ...payload, sessionId: "missing" })).status).toBe(
      401,
    );
    authenticatedHost = "host-a";
    expect((await request({ ...payload, hostId: "host-b" })).status).toBe(400);
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    db.$client.close();
  }
});

it("rejects invalid host-channel addresses and requires the updated protocol", () => {
  const payload = {
    sessionId: "session",
    port: 3000,
    url: "https://preview.example/page",
  };
  expect(
    hostDaemonConnectAnnotationsRequestSchema.safeParse(payload).success,
  ).toBe(true);
  for (const invalid of [
    { ...payload, port: 0 },
    { ...payload, url: "javascript:alert(1)" },
    { ...payload, hostId: "other" },
    { ...payload, sessionId: "" },
  ])
    expect(
      hostDaemonConnectAnnotationsRequestSchema.safeParse(invalid).success,
    ).toBe(false);
  expect(HOST_DAEMON_PROTOCOL_VERSION).toBeGreaterThan(267);
});
