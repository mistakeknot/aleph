import { afterEach, describe, expect, it } from "vitest";
import {
  STAGING_BACKEND_PORT,
  STAGING_FIXTURE_PATH,
  STAGING_HTTPS_PORT,
  STAGING_ORIGIN,
  STAGING_ORIGIN_PREFIX,
} from "../../../scripts/lib/aleph-staging-origin.mjs";
import { createStagingFixtureServer } from "../../../scripts/lib/aleph-staging-fixture.mjs";

let server;

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
  server?.closeAllConnections();
  server = undefined;
});

async function start(options) {
  server = createStagingFixtureServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}${STAGING_FIXTURE_PATH}`;
}

function get(url, init) {
  return fetch(url, { redirect: "manual", ...init });
}

describe("staging origin constant", () => {
  it("pins the tailnet name on a dedicated port that is not 3002", () => {
    expect(STAGING_ORIGIN).toBe(
      `https://zklw.tail1c1ab6.ts.net:${STAGING_HTTPS_PORT}`,
    );
    expect(STAGING_ORIGIN_PREFIX).toBe(`${STAGING_ORIGIN}/aleph-staging/`);
    expect([STAGING_HTTPS_PORT, STAGING_BACKEND_PORT]).not.toContain(3002);
    expect(STAGING_HTTPS_PORT).toBe(8443);
  });
});

describe("staging fixture server", () => {
  it("serves static ZIP and JSON bytes", async () => {
    const base = await start();
    const zip = await get(`${base}fixture.zip`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    const bytes = new Uint8Array(await zip.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x05, 0x06]);

    const json = await get(`${base}fixture.json`);
    expect(json.headers.get("content-type")).toBe("application/json");
    expect(await json.json()).toEqual({ fixture: true, signed: false });
  });

  it.each([
    ["r/other-host", "https://example.com/aleph-staging/fixture/fixture.json"],
    [
      "r/http",
      `http://zklw.tail1c1ab6.ts.net:${STAGING_HTTPS_PORT}${STAGING_FIXTURE_PATH}fixture.json`,
    ],
    ["r/2hop", `${STAGING_ORIGIN}${STAGING_FIXTURE_PATH}r/2hop-mid`],
    [
      "r/wrong-prefix",
      `${STAGING_ORIGIN}/not-aleph-staging/fixture/fixture.json`,
    ],
  ])("redirects %s to a hop the verifier must refuse", async (name, target) => {
    const base = await start();
    const response = await get(`${base}${name}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(target);
  });

  it("completes the second hop of /r/2hop at a valid staging URL", async () => {
    const base = await start();
    const response = await get(`${base}r/2hop-mid`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${STAGING_ORIGIN}${STAGING_FIXTURE_PATH}fixture.json`,
    );
  });

  it("sends slow endpoint headers at once and delays the body", async () => {
    const base = await start({ slowMs: 600 });
    const startedAt = Date.now();
    const response = await get(`${base}slow`);
    const headersAt = Date.now() - startedAt;
    expect(response.status).toBe(200);
    expect(headersAt).toBeLessThan(300);
    await response.text();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(580);
  });

  it("serves an oversize body with a matching content-length", async () => {
    const base = await start({ oversizeBytes: 3_000_000 });
    const response = await get(`${base}oversize`);
    expect(response.headers.get("content-length")).toBe("3000000");
    let received = 0;
    for await (const chunk of response.body) received += chunk.length;
    expect(received).toBe(3_000_000);
  });

  it("refuses methods other than GET and HEAD and unknown paths", async () => {
    const base = await start();
    expect((await get(`${base}fixture.json`, { method: "POST" })).status).toBe(
      405,
    );
    expect((await get(`${base}nope`)).status).toBe(404);
    expect(
      (await get(`http://127.0.0.1:${server.address().port}/`)).status,
    ).toBe(404);
  });

  it("sends no cookies or credentials headers", async () => {
    const base = await start();
    const response = await get(`${base}fixture.json`);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("binds loopback only", async () => {
    await start();
    expect(server.address().address).toBe("127.0.0.1");
  });
});
