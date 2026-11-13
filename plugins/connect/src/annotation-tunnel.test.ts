import { expect, it } from "vitest";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { OpenHttpFrame } from "@bb/tunnel-contract";
import { AnnotationStore } from "./annotation-store.js";
import { AnnotationTunnel } from "./annotation-tunnel.js";

const origin = "https://preview.example";
it("transforms only owner HTML and leaves unsafe response streams unread", async () => {
  const { bridge } = fixture();
  const body = Buffer.from("<!doctype html><html><body>Preview</body></html>");
  const response = () => {
    const incoming = new IncomingMessage(new Socket());
    incoming.statusCode = 200;
    incoming.rawHeaders = [
      "Content-Type",
      "text/html",
      "Content-Length",
      String(body.length),
    ];
    incoming.push(body);
    incoming.push(null);
    return incoming;
  };
  const page = { ...meta, path: "/page" };
  const anonymous = response();
  expect(
    (await bridge.transform({ ...page, headers: [] }, anonymous)).body,
  ).toBe(anonymous);
  expect(anonymous.readableFlowing).toBeNull();
  anonymous.destroy();
  const compressed = response();
  compressed.rawHeaders.push("Content-Encoding", "gzip");
  expect((await bridge.transform(page, compressed)).body).toBe(compressed);
  expect(compressed.readableFlowing).toBeNull();
  compressed.destroy();
  const rewritten = await bridge.transform(page, response());
  const chunks: Uint8Array[] = [];
  for await (const chunk of rewritten.body) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toContain("/__bb_annotations");
  expect(rewritten.headers).toContainEqual([
    "cache-control",
    "private, no-store",
  ]);
});
const meta: OpenHttpFrame = {
  type: "open-http",
  streamId: 1,
  method: "GET",
  path: `/__bb_annotations?url=${encodeURIComponent(origin + "/page")}`,
  headers: [["x-bb-gate-auth", "session"]],
  hasBody: false,
  target: "3000",
};
function fixture() {
  const values = new Map<string, unknown>();
  const store = new AnnotationStore({
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key, value) => {
      values.set(key, value);
    },
  });
  return {
    store,
    bridge: new AnnotationTunnel(store, (port) =>
      port === 3000 ? origin : null,
    ),
  };
}

it("refuses anonymous, duplicate markers, non-owner identities and unshared ports", async () => {
  const { bridge } = fixture();
  for (const headers of [
    [],
    [["x-bb-gate-auth", "machine"]],
    [
      ["x-bb-gate-auth", "session"],
      ["x-bb-gate-auth", "session"],
    ],
  ] as OpenHttpFrame["headers"][]) {
    expect(
      (await bridge.intercept({ ...meta, headers }, undefined))?.status,
    ).toBe(403);
  }
  expect(
    (await bridge.intercept({ ...meta, target: "3001" }, undefined))?.status,
  ).toBe(403);
  expect(
    await bridge.intercept({ ...meta, target: undefined }, undefined),
  ).toBeNull();
  expect((await bridge.intercept(meta, undefined))?.status).toBe(200);
});

it("rejects cross-origin writes, cross-share reads and send messages", async () => {
  const { bridge } = fixture();
  expect(
    (await bridge.intercept({ ...meta, method: "POST" }, Buffer.from("{}")))
      ?.status,
  ).toBe(403);
  expect(
    (
      await bridge.intercept(
        { ...meta, path: "/__bb_annotations?url=https://other.example/" },
        undefined,
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await bridge.intercept(
        {
          ...meta,
          method: "POST",
          headers: [
            ...meta.headers,
            ["origin", origin],
            ["content-type", "application/json"],
          ],
        },
        Buffer.from('{"type":"send-to-thread"}'),
      )
    )?.status,
  ).toBe(400);
});

it("persists notes and updates only the selected page", async () => {
  const { store, bridge } = fixture();
  const annotation = {
    id: "abc",
    number: 1,
    comment: "Move this",
    url: origin + "/page",
    title: "Preview",
    viewport: { width: 800, height: 600 },
    element: {
      tagName: "button",
      name: "Save",
      selector: "#save",
      text: "Save",
      attributes: {},
      styles: {},
      rect: { x: 1, y: 2, width: 30, height: 20 },
    },
  };
  const request = {
    ...meta,
    method: "POST",
    headers: [
      ...meta.headers,
      ["origin", origin],
      ["content-type", "application/json"],
    ] as OpenHttpFrame["headers"],
  };
  expect(
    (
      await bridge.intercept(
        request,
        Buffer.from(JSON.stringify({ type: "annotation", annotation })),
      )
    )?.status,
  ).toBe(200);
  expect(await store.list({ port: 3000, url: annotation.url })).toMatchObject([
    {
      author: "Owner",
      element: annotation.element,
      capture: { reason: expect.any(String) },
    },
  ]);
  expect(await store.list({ port: 3000, url: origin + "/elsewhere" })).toEqual(
    [],
  );
  expect(
    (
      await bridge.intercept(
        request,
        Buffer.from(
          JSON.stringify({
            type: "annotation-update",
            id: "abc",
            comment: "Keep this",
          }),
        ),
      )
    )?.status,
  ).toBe(200);
  expect(await store.list({ port: 3000, url: annotation.url })).toMatchObject([
    { comment: "Keep this" },
  ]);
});
