import { BbHttpError } from "@bb/sdk/browser";
import type {
  SystemAlephUpdateRun,
  SystemAlephUpdateStatus,
} from "@bb/server-contract";
import { fetchWithAppSurface } from "./app-surface";
import type { AlephUpdateOperation } from "./aleph-update-nonce";

export const ALEPH_UPDATE_GUARD_HEADER = "x-aleph-update";

const BASE_PATH = "/api/v1/system/aleph-update";

function baseUrl(): string {
  return typeof window === "undefined"
    ? "http://localhost"
    : window.location.origin;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return `request failed with status ${String(status)}`;
}

function errorCode(body: unknown): string | null {
  if (typeof body === "object" && body !== null) {
    const code = (body as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

async function request<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set(ALEPH_UPDATE_GUARD_HEADER, "1");
  const response = await fetchWithAppSurface(
    `${baseUrl()}${BASE_PATH}${path}`,
    {
      ...init,
      headers,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const body = await readBody(response);
  if (!response.ok) {
    throw new BbHttpError({
      body,
      code: errorCode(body),
      message: errorMessage(body, response.status),
      status: response.status,
    });
  }
  return body as T;
}

export function fetchAlephUpdateStatus(
  signal?: AbortSignal,
): Promise<SystemAlephUpdateStatus> {
  return request<SystemAlephUpdateStatus>("", { method: "GET" }, signal);
}

export function fetchAlephUpdateRun(
  nonce: string,
  signal?: AbortSignal,
): Promise<SystemAlephUpdateRun> {
  return request<SystemAlephUpdateRun>(
    `/runs/${encodeURIComponent(nonce)}`,
    { method: "GET" },
    signal,
  );
}

export function postAlephUpdate(
  operation: AlephUpdateOperation,
  body: Record<string, unknown>,
): Promise<SystemAlephUpdateRun> {
  return request<SystemAlephUpdateRun>(`/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function alephErrorCommand(error: unknown): string | null {
  if (!(error instanceof BbHttpError)) return null;
  const body = error.body;
  if (typeof body !== "object" || body === null) return null;
  const details = (body as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const command = (details as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}
