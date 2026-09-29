import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import {
  RELAY_ERROR_HTTP_STATUS,
  RELAY_ERROR_RETRYABLE,
  RELAY_PROTOCOL_VERSION,
  RELAY_REQUEST_BODY_MAX_BYTES,
  RELAY_DAEMON_CONCURRENCY,
  classifyRelayParseError,
  decodeRelayAttachments,
  relayErrorCodeSchema,
  relayTargetsRemoveRequestSchema,
  relayTellRequestSchema,
  type RelayErrorCode,
  type RelayErrorResponse,
} from "@bb/host-daemon-contract/relay";
import type { z } from "zod";
import type { HostDaemonLogger } from "../logger.js";
import { ServerResponseError, type ServerClient } from "../server-client.js";

export const RELAY_SOCKET_HOST = "bb-relay";
export const RELAY_BUSY_RETRY_AFTER_MS = 1000;
export const RELAY_FORWARD_TIMEOUT_MS = 60_000;

const BROWSER_REQUEST_HEADERS = [
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "referer",
  "cookie",
] as const;

const MAX_UPSTREAM_MESSAGE_CHARS = 500;

export interface RelayHandlerDeps {
  hostId: string;
  logger: HostDaemonLogger;
  isConnected: () => boolean;
  client: Pick<
    ServerClient,
    "relayTell" | "relayTargets" | "relayTargetsRemove"
  >;
  forwardTimeoutMs?: number;
  maxConcurrent?: number;
}

interface RelayReply {
  status: number;
  body: unknown;
  code?: RelayErrorCode;
  closeConnection?: boolean;
  headers?: Record<string, string>;
}

type RelayRoute = "status" | "tell" | "targets" | "targetsRemove";

const ROUTES: Record<string, { method: "GET" | "POST"; route: RelayRoute }> = {
  "/v1/status": { method: "GET", route: "status" },
  "/v1/tell": { method: "POST", route: "tell" },
  "/v1/targets": { method: "GET", route: "targets" },
  "/v1/targets/remove": { method: "POST", route: "targetsRemove" },
};

export function isRelayBrowserRequest(headers: IncomingHttpHeaders): boolean {
  return BROWSER_REQUEST_HEADERS.some((name) => headers[name] !== undefined);
}

function relayError(
  code: RelayErrorCode,
  message: string,
  options: { retryAfterMs?: number; status?: number; retryable?: boolean } = {},
): RelayReply {
  const body: RelayErrorResponse = {
    error: {
      code,
      message,
      retryable: options.retryable ?? RELAY_ERROR_RETRYABLE[code],
      ...(options.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: options.retryAfterMs }),
    },
  };
  return {
    status: options.status ?? RELAY_ERROR_HTTP_STATUS[code],
    body,
    code,
  };
}

function describeParseIssues(error: z.ZodError): string {
  const paths = new Set<string>();
  for (const issue of error.issues) {
    paths.add(issue.path.length === 0 ? "(body)" : issue.path.join("."));
  }
  return `request failed validation: ${[...paths].slice(0, 8).join(", ")}`;
}

function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) {
    return false;
  }
  const mediaType = header.split(";")[0];
  return mediaType?.trim().toLowerCase() === "application/json";
}

type ReadBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "aborted" };

async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<ReadBodyResult> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > maxBytes) {
    return { ok: false, reason: "too_large" };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        return { ok: false, reason: "too_large" };
      }
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, reason: "aborted" };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function mapForwardError(error: unknown): RelayReply {
  if (error instanceof ServerResponseError) {
    if (error.status === 401) {
      return relayError("host_revoked", "Host key was rejected by the server");
    }
    const parsedCode = relayErrorCodeSchema.safeParse(error.code);
    if (parsedCode.success) {
      const code = parsedCode.data;
      return relayError(code, upstreamMessage(error), {
        ...(error.retryAfterMs === null
          ? {}
          : { retryAfterMs: error.retryAfterMs }),
      });
    }
    if (error.status === 404 || error.status === 405) {
      return relayError("server_unreachable", "Server does not support relay");
    }
    if (error.status >= 500) {
      return relayError("internal_error", "Server error", {
        status: error.status,
        retryable: true,
      });
    }
    return relayError("internal_error", "Server rejected the request", {
      status: 502,
      retryable: false,
    });
  }
  if (error instanceof Error && error.name === "ZodError") {
    return relayError("internal_error", "Unexpected server response", {
      status: 502,
      retryable: true,
    });
  }
  return relayError("server_unreachable", "Server is unreachable");
}

function upstreamMessage(error: ServerResponseError): string {
  const message = error.bodyMessage ?? "Request failed";
  return message.slice(0, MAX_UPSTREAM_MESSAGE_CHARS);
}

function writeReply(response: ServerResponse, reply: RelayReply): void {
  const payload = JSON.stringify(reply.body);
  response.writeHead(reply.status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...(reply.closeConnection ? { connection: "close" } : {}),
    ...reply.headers,
  });
  response.end(payload);
}

export function createRelayRequestHandler(
  deps: RelayHandlerDeps,
): (request: IncomingMessage, response: ServerResponse) => void {
  const maxConcurrent = deps.maxConcurrent ?? RELAY_DAEMON_CONCURRENCY;
  const forwardTimeoutMs = deps.forwardTimeoutMs ?? RELAY_FORWARD_TIMEOUT_MS;
  let inFlight = 0;

  function logForward(fields: {
    action: string;
    clientMessageId?: string;
    threadId?: string;
    status: number;
    code?: string;
  }): void {
    deps.logger.info(
      { hostId: deps.hostId, ...fields },
      "Relay request forwarded",
    );
  }

  async function forwardTell(rawBody: string): Promise<RelayReply> {
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return relayError("invalid_request", "Body must be valid JSON");
    }
    const parsed = relayTellRequestSchema.safeParse(json);
    if (!parsed.success) {
      return relayError(
        classifyRelayParseError(parsed.error),
        describeParseIssues(parsed.error),
      );
    }
    const request = parsed.data;
    if (request.attachments !== undefined) {
      const decoded = decodeRelayAttachments(request.attachments);
      if (!decoded.ok) {
        return relayError(decoded.code, decoded.message);
      }
    }
    if (!deps.isConnected()) {
      return relayError("daemon_disconnected", "Daemon is not connected");
    }
    try {
      const result = await deps.client.relayTell(
        request,
        AbortSignal.timeout(forwardTimeoutMs),
      );
      logForward({
        action: "tell",
        clientMessageId: request.clientMessageId,
        threadId: request.threadId,
        status: 200,
      });
      return { status: 200, body: result };
    } catch (error) {
      const reply = mapForwardError(error);
      logForward({
        action: "tell",
        clientMessageId: request.clientMessageId,
        threadId: request.threadId,
        status: reply.status,
        ...(reply.code === undefined ? {} : { code: reply.code }),
      });
      return reply;
    }
  }

  async function forwardTargets(): Promise<RelayReply> {
    if (!deps.isConnected()) {
      return relayError("daemon_disconnected", "Daemon is not connected");
    }
    try {
      const result = await deps.client.relayTargets(
        AbortSignal.timeout(forwardTimeoutMs),
      );
      logForward({ action: "targets", status: 200 });
      return { status: 200, body: result };
    } catch (error) {
      const reply = mapForwardError(error);
      logForward({
        action: "targets",
        status: reply.status,
        ...(reply.code === undefined ? {} : { code: reply.code }),
      });
      return reply;
    }
  }

  async function forwardTargetsRemove(rawBody: string): Promise<RelayReply> {
    let json: unknown = {};
    if (rawBody.trim() !== "") {
      try {
        json = JSON.parse(rawBody);
      } catch {
        return relayError("invalid_request", "Body must be valid JSON");
      }
    }
    const parsed = relayTargetsRemoveRequestSchema.safeParse(json);
    if (!parsed.success) {
      return relayError(
        classifyRelayParseError(parsed.error),
        describeParseIssues(parsed.error),
      );
    }
    if (!deps.isConnected()) {
      return relayError("daemon_disconnected", "Daemon is not connected");
    }
    try {
      const result = await deps.client.relayTargetsRemove(
        parsed.data,
        AbortSignal.timeout(forwardTimeoutMs),
      );
      logForward({
        action: "targets-remove",
        ...(parsed.data.threadId === undefined
          ? {}
          : { threadId: parsed.data.threadId }),
        status: 200,
      });
      return { status: 200, body: result };
    } catch (error) {
      const reply = mapForwardError(error);
      logForward({
        action: "targets-remove",
        ...(parsed.data.threadId === undefined
          ? {}
          : { threadId: parsed.data.threadId }),
        status: reply.status,
        ...(reply.code === undefined ? {} : { code: reply.code }),
      });
      return reply;
    }
  }

  async function handle(request: IncomingMessage): Promise<RelayReply> {
    if (isRelayBrowserRequest(request.headers)) {
      return relayError(
        "browser_request_forbidden",
        "Browser requests are not allowed",
      );
    }
    if (request.headers.host !== RELAY_SOCKET_HOST) {
      return relayError("browser_request_forbidden", "Unexpected Host header");
    }
    const target = request.url;
    if (
      target === undefined ||
      !target.startsWith("/") ||
      target.startsWith("//")
    ) {
      return relayError("invalid_request", "Invalid request target", {
        status: 400,
      });
    }
    const pathname = target.split("?")[0] ?? "";
    const matched = Object.hasOwn(ROUTES, pathname)
      ? ROUTES[pathname]
      : undefined;
    if (matched === undefined) {
      return relayError("invalid_request", "Not found", { status: 404 });
    }
    if (request.method !== matched.method) {
      return {
        ...relayError("invalid_request", "Method not allowed", { status: 405 }),
        headers: { allow: matched.method },
      };
    }
    if (matched.route === "status") {
      return {
        status: 200,
        body: {
          relayProtocol: RELAY_PROTOCOL_VERSION,
          hostId: deps.hostId,
          connected: deps.isConnected(),
        },
      };
    }
    if (
      matched.method === "POST" &&
      !isJsonContentType(request.headers["content-type"])
    ) {
      return relayError(
        "invalid_request",
        "Content-Type must be application/json",
        { status: 415 },
      );
    }
    if (inFlight >= maxConcurrent) {
      return relayError("relay_busy", "Too many relay requests in flight", {
        retryAfterMs: RELAY_BUSY_RETRY_AFTER_MS,
      });
    }
    inFlight += 1;
    try {
      if (matched.route === "targets") {
        return await forwardTargets();
      }
      const body = await readBody(request, RELAY_REQUEST_BODY_MAX_BYTES);
      if (!body.ok) {
        return {
          ...relayError(
            body.reason === "too_large"
              ? "payload_too_large"
              : "invalid_request",
            body.reason === "too_large"
              ? "Request body is too large"
              : "Request body was interrupted",
          ),
          closeConnection: true,
        };
      }
      return matched.route === "tell"
        ? await forwardTell(body.text)
        : await forwardTargetsRemove(body.text);
    } finally {
      inFlight -= 1;
    }
  }

  return (request, response) => {
    void handle(request)
      .then((reply) => {
        writeReply(response, reply);
        if (reply.closeConnection) {
          response.once("finish", () => request.socket.destroy());
        }
      })
      .catch(() => {
        writeReply(
          response,
          relayError("internal_error", "Relay request failed"),
        );
      });
  };
}
