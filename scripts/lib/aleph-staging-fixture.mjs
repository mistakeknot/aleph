import { createServer } from "node:http";
import {
  STAGING_FIXTURE_PATH,
  STAGING_HOST,
  STAGING_HTTPS_PORT,
  STAGING_ORIGIN,
} from "./aleph-staging-origin.mjs";

const EMPTY_ZIP = Buffer.from([
  0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const FIXTURE_JSON = Buffer.from(
  JSON.stringify({ fixture: true, signed: false }),
);
const OVERSIZE_CHUNK = Buffer.alloc(64 * 1024);

const FIXTURE_JSON_URL = `${STAGING_ORIGIN}${STAGING_FIXTURE_PATH}fixture.json`;

const REDIRECTS = new Map([
  ["r/other-host", "https://example.com/aleph-staging/fixture/fixture.json"],
  [
    "r/http",
    `http://${STAGING_HOST}:${STAGING_HTTPS_PORT}${STAGING_FIXTURE_PATH}fixture.json`,
  ],
  ["r/2hop", `${STAGING_ORIGIN}${STAGING_FIXTURE_PATH}r/2hop-mid`],
  ["r/2hop-mid", FIXTURE_JSON_URL],
  [
    "r/wrong-prefix",
    `${STAGING_ORIGIN}/not-aleph-staging/fixture/fixture.json`,
  ],
]);

function sendBytes(request, response, contentType, bytes) {
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": bytes.length,
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

function sendOversize(request, response, totalBytes) {
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": totalBytes,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  let remaining = totalBytes;
  const writeMore = () => {
    while (remaining > 0) {
      const size = Math.min(remaining, OVERSIZE_CHUNK.length);
      remaining -= size;
      const flushed = response.write(OVERSIZE_CHUNK.subarray(0, size));
      if (!flushed) {
        response.once("drain", writeMore);
        return;
      }
    }
    response.end();
  };
  writeMore();
}

function sendSlow(request, response, slowMs) {
  response.writeHead(200, { "content-type": "application/octet-stream" });
  response.flushHeaders();
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const timer = setTimeout(() => response.end("slow"), slowMs);
  response.once("close", () => clearTimeout(timer));
}

export function createStagingFixtureServer({
  slowMs = 30_000,
  oversizeBytes = 256 * 1024 * 1024,
} = {}) {
  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const { pathname } = new URL(request.url ?? "/", "http://fixture.invalid");
    if (!pathname.startsWith(STAGING_FIXTURE_PATH)) {
      response.writeHead(404).end();
      return;
    }
    const name = pathname.slice(STAGING_FIXTURE_PATH.length);
    const redirect = REDIRECTS.get(name);
    if (redirect !== undefined) {
      response.writeHead(302, { location: redirect }).end();
    } else if (name === "fixture.zip") {
      sendBytes(request, response, "application/zip", EMPTY_ZIP);
    } else if (name === "fixture.json") {
      sendBytes(request, response, "application/json", FIXTURE_JSON);
    } else if (name === "slow") {
      sendSlow(request, response, slowMs);
    } else if (name === "oversize") {
      sendOversize(request, response, oversizeBytes);
    } else {
      response.writeHead(404).end();
    }
  });
}
