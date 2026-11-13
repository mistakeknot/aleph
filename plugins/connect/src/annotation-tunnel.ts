import type { IncomingMessage } from "node:http";
import type { HeaderPair, OpenHttpFrame } from "@bb/tunnel-contract";
import { buildConnectAnnotationsScript } from "bb-plugin-agent-annotations/page-script.js";
import {
  annotationChangeSchema,
  AnnotationStore,
  annotationScopeSchema,
} from "./annotation-store.js";
import {
  annotationHtml,
  annotationHtmlEligible,
  MAX_ANNOTATION_HTML_BYTES,
} from "./annotation-html.js";

const ENDPOINT = "/__bb_annotations";
const script = buildConnectAnnotationsScript(ENDPOINT);

export class AnnotationTunnel {
  constructor(
    private readonly store: AnnotationStore,
    private readonly originForPort: (port: number) => string | null,
  ) {}
  private scope(meta: OpenHttpFrame): { port: number; origin: string } | null {
    if (meta.target === undefined) return null;
    const auth = meta.headers.filter(
      ([name]) => name.toLowerCase() === "x-bb-gate-auth",
    );
    if (auth.length !== 1 || auth[0]?.[1] !== "session") return null;
    const port = Number(meta.target);
    const origin = this.originForPort(port);
    return origin === null ? null : { port, origin };
  }
  async intercept(meta: OpenHttpFrame, body: Buffer | undefined) {
    if (meta.target === undefined || meta.path.split("?", 1)[0] !== ENDPOINT)
      return null;
    const reply = (status: number, data: unknown) => ({
      status,
      headers: [
        ["content-type", "application/json"],
        ["cache-control", "private, no-store"],
      ] as HeaderPair[],
      body: Buffer.from(JSON.stringify(data)),
    });
    const share = this.scope(meta);
    if (!share) return reply(403, { error: "Owner session required" });
    try {
      const url = new URL(meta.path, share.origin).searchParams.get("url");
      const scope = annotationScopeSchema.parse({ port: share.port, url });
      if (new URL(scope.url).origin !== share.origin)
        return reply(403, { error: "Wrong share" });
      if (meta.method === "GET")
        return reply(200, await this.store.list(scope));
      if (meta.method !== "POST")
        return reply(405, { error: "Method not allowed" });
      const headers = new Headers(meta.headers);
      if (
        headers.get("origin") !== share.origin ||
        headers.get("content-type") !== "application/json"
      )
        return reply(403, { error: "Same-origin JSON required" });
      if (!body || body.length > 32_768)
        return reply(413, { error: "Annotation too large" });
      const change = annotationChangeSchema.parse(
        JSON.parse(body.toString("utf8")),
      );
      return reply(200, await this.store.change(scope, change));
    } catch {
      return reply(400, { error: "Invalid annotation request" });
    }
  }
  async transform(
    meta: OpenHttpFrame,
    response: IncomingMessage,
  ): Promise<{ headers: HeaderPair[]; body: AsyncIterable<Uint8Array> }> {
    const headers: HeaderPair[] = [];
    for (let index = 0; index < response.rawHeaders.length; index += 2)
      headers.push([
        response.rawHeaders[index]!,
        response.rawHeaders[index + 1]!,
      ]);
    const unchanged = { headers, body: response };
    if (
      meta.method !== "GET" ||
      !this.scope(meta) ||
      !annotationHtmlEligible(headers, response.statusCode ?? 502)
    )
      return unchanged;
    const chunks: Buffer[] = [];
    let length = 0;
    const iterator = response[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      chunks.push(chunk);
      length += chunk.length;
      if (length > MAX_ANNOTATION_HTML_BYTES) {
        return {
          headers,
          body: (async function* () {
            yield* chunks;
            while (true) {
              const rest = await iterator.next();
              if (rest.done) break;
              yield Buffer.from(rest.value);
            }
          })(),
        };
      }
    }
    const body = Buffer.concat(chunks);
    const result = annotationHtml(
      headers,
      body,
      script,
      response.statusCode ?? 502,
    );
    return {
      headers: result?.headers ?? headers,
      body: (async function* () {
        yield result?.body ?? body;
      })(),
    };
  }
}
