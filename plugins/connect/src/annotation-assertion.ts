import type { IncomingMessage } from "node:http";
import type { HeaderPair, OpenHttpFrame } from "@bb/tunnel-contract";
import {
  GATE_ASSERTION_HEADER,
  verifyGateAssertion,
} from "@bb/tunnel-contract/next";
import type { AnnotationTunnel } from "./annotation-tunnel.js";

interface AssertionRequest {
  method: string;
  path: string;
  target: string;
  headers: HeaderPair[];
}

interface AssertionIngressOptions {
  audience: string;
  keys(): Promise<ReadonlyMap<string, CryptoKey>>;
  nowSeconds(): number;
  originForTarget(target: string): string | null;
  annotations: AnnotationTunnel;
}

export class AnnotationAssertionIngress {
  constructor(private readonly options: AssertionIngressOptions) {}

  async verify(request: AssertionRequest): Promise<{
    previewHeaders: HeaderPair[];
    intercept(
      body: Buffer | undefined,
    ): ReturnType<AnnotationTunnel["intercept"]>;
    transform(
      response: IncomingMessage,
    ): ReturnType<AnnotationTunnel["transform"]>;
  } | null> {
    if (!request.path.startsWith("/") || request.path.startsWith("//"))
      return null;
    if (
      !/^[1-9][0-9]{0,4}$/.test(request.target) ||
      Number(request.target) > 65535
    )
      return null;
    const tokens = request.headers.filter(
      ([name]) => name.toLowerCase() === GATE_ASSERTION_HEADER,
    );
    if (tokens.length !== 1 || !tokens[0]?.[1]) return null;
    const result = await verifyGateAssertion(tokens[0][1], {
      keys: await this.options.keys(),
      audience: this.options.audience,
      method: request.method,
      pathAndQuery: request.path,
      nowSeconds: this.options.nowSeconds(),
    });
    if (!result.ok || result.claims.target !== request.target) return null;
    if (this.options.originForTarget(request.target) === null) return null;
    const headers = request.headers.filter(
      ([name]) => !name.toLowerCase().startsWith("x-bb-gate-"),
    );
    const previewHeaders = headers.filter(
      ([name]) =>
        !["authorization", "cookie", "proxy-authorization"].includes(
          name.toLowerCase(),
        ),
    );
    const meta: OpenHttpFrame = {
      type: "open-http",
      streamId: 1,
      method: request.method,
      path: request.path,
      target: request.target,
      hasBody: request.method !== "GET" && request.method !== "HEAD",
      headers: [...previewHeaders, ["x-bb-gate-auth", result.claims.kind]],
    };
    return {
      previewHeaders,
      intercept: (body) => this.options.annotations.intercept(meta, body),
      transform: (response) =>
        this.options.annotations.transform(meta, response),
    };
  }
}
