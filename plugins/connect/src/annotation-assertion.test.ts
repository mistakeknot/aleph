import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { expect, it } from "vitest";
import {
  generateGateKeyPair,
  importGateKeySet,
  signGateAssertion,
  type SignGateAssertionInput,
} from "@bb/tunnel-contract/next";
import { AnnotationAssertionIngress } from "./annotation-assertion.js";
import { AnnotationStore } from "./annotation-store.js";
import { AnnotationTunnel } from "./annotation-tunnel.js";

const origin = "https://preview.example";
const path = `/__bb_annotations?url=${encodeURIComponent(origin + "/page")}`;
const now = 1_800_000_000;

async function fixture(audience: string) {
  const pair = await generateGateKeyPair("test");
  const keys = await importGateKeySet({ keys: [pair.publicKey] });
  const values = new Map<string, unknown>();
  const store = new AnnotationStore({
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key, value) => {
      values.set(key, value);
    },
  });
  const bridge = new AnnotationTunnel(store, (port) =>
    port === 3000 ? origin : null,
  );
  const ingress = new AnnotationAssertionIngress({
    audience,
    keys: async () => keys,
    nowSeconds: () => now,
    originForTarget: (target) => (target === "3000" ? origin : null),
    annotations: bridge,
  });
  const token = (overrides: Partial<SignGateAssertionInput> = {}) =>
    signGateAssertion(pair.signingKey, {
      audience,
      subject: "owner",
      kind: "session",
      method: "GET",
      pathAndQuery: path,
      target: "3000",
      oauth: null,
      nowSeconds: now,
      ...overrides,
    });
  const request = (
    value: string,
    overrides: Partial<{ method: string; path: string; target: string }> = {},
  ) => ({
    method: "GET",
    path,
    target: "3000",
    headers: [
      ["x-bb-gate-assertion", value],
      ["x-bb-gate-auth", "session"],
    ] as [string, string][],
    ...overrides,
  });
  return { ingress, token, request, store };
}

for (const audience of ["server:test", "machine:test"]) {
  it(`${audience} rejects spoofing, invalid signatures and mismatched bindings`, async () => {
    const { ingress, token, request } = await fixture(audience);
    for (const overrides of [
      { audience: "server:other" },
      { method: "POST" },
      { pathAndQuery: path + "&x=1" },
      { target: "3001" },
      { target: null },
      { nowSeconds: now - 120 },
    ]) {
      expect(await ingress.verify(request(await token(overrides)))).toBeNull();
    }
    expect(await ingress.verify(request("forged"))).toBeNull();
    expect(
      await ingress.verify({
        ...request(""),
        headers: [["x-bb-gate-auth", "session"]],
      }),
    ).toBeNull();
    const valid = await token();
    const [payload, signature] = valid.split(".");
    expect(
      await ingress.verify(
        request(
          `${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`,
        ),
      ),
    ).toBeNull();
    expect(
      await ingress.verify({
        ...request(valid),
        headers: [...request(valid).headers, ["X-BB-Gate-Assertion", valid]],
      }),
    ).toBeNull();
    expect(
      await ingress.verify(
        request(await token({ target: "3001" }), { target: "3001" }),
      ),
    ).toBeNull();
  });

  it(`${audience} derives identity from the assertion and preserves strict CSP`, async () => {
    const { ingress, token, request } = await fixture(audience);
    const makeResponse = (type = "text/html") => {
      const body = Buffer.from(
        '<html><body><button id="save">Save</button></body></html>',
      );
      const response = new IncomingMessage(new Socket());
      response.statusCode = 200;
      response.rawHeaders = [
        "Content-Type",
        type,
        "Content-Length",
        String(body.length),
        "Content-Security-Policy",
        "default-src 'none'; script-src 'nonce-test'; style-src 'none'; connect-src 'self'",
      ];
      response.push(body);
      response.push(null);
      return response;
    };
    for (const kind of ["public", "machine", "oauth"] as const) {
      const verified = await ingress.verify(
        request(
          await token({ kind, subject: kind === "public" ? "" : "visitor" }),
        ),
      );
      expect(verified).not.toBeNull();
      expect((await verified!.intercept(undefined))?.status).toBe(403);
      const response = makeResponse();
      expect((await verified!.transform(response)).body).toBe(response);
      response.destroy();
    }
    const verified = await ingress.verify(request(await token()));
    expect((await verified!.intercept(undefined))?.status).toBe(200);
    const rewritten = await verified!.transform(makeResponse());
    const chunks = [];
    for await (const chunk of rewritten.body) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toContain('<script nonce="test">');
    expect(rewritten.headers).toContainEqual([
      "Content-Security-Policy",
      "default-src 'none'; script-src 'nonce-test'; style-src 'none'; connect-src 'self'",
    ]);
    const denied = makeResponse();
    denied.rawHeaders[5] = "default-src 'none'; script-src 'none'";
    const unchanged = await verified!.transform(denied);
    const deniedChunks = [];
    for await (const chunk of unchanged.body) deniedChunks.push(chunk);
    expect(Buffer.concat(deniedChunks).toString()).not.toContain(
      "/__bb_annotations",
    );
    const json = makeResponse("application/json");
    expect((await verified!.transform(json)).body).toBe(json);
    json.destroy();
  });

  it(`${audience} persists only same-origin page notes without forwarding credentials`, async () => {
    const { ingress, token, request, store } = await fixture(audience);
    const annotation = {
      id: "pin",
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
    const meta = request(await token({ method: "POST" }), { method: "POST" });
    meta.headers.push(
      ["origin", origin],
      ["content-type", "application/json"],
      ["authorization", "secret"],
      ["cookie", "secret"],
    );
    const verified = await ingress.verify(meta);
    expect(
      verified!.previewHeaders.some(([name]) =>
        /gate|authorization|cookie/i.test(name),
      ),
    ).toBe(false);
    expect(
      (
        await verified!.intercept(
          Buffer.from(JSON.stringify({ type: "annotation", annotation })),
        )
      )?.status,
    ).toBe(200);
    expect(await store.list({ port: 3000, url: annotation.url })).toMatchObject(
      [{ id: "pin", author: "Owner" }],
    );
    expect(await store.list({ port: 3000, url: origin + "/other" })).toEqual(
      [],
    );
    meta.headers = meta.headers.filter(([name]) => name !== "origin");
    meta.headers.push(["origin", "https://other.example"]);
    const crossOrigin = await ingress.verify(meta);
    expect((await crossOrigin!.intercept(Buffer.from("{}")))?.status).toBe(403);
  });
}
