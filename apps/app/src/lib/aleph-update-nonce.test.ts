import { describe, expect, it } from "vitest";
import {
  ALEPH_NONCE_RESEND_MS,
  ALEPH_NONCE_UNKNOWN_MS,
  alephOutcomeUnknownMessage,
  createAlephNonceStore,
  evaluateAlephPending,
  generateAlephNonce,
} from "./aleph-update-nonce";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  };
}

const BODY = { confirm: "update", interrupt: false, target: "0.5.4" };

describe("generateAlephNonce", () => {
  it("returns 32 lowercase hex characters from the random source", () => {
    const nonce = generateAlephNonce((bytes) => {
      bytes.fill(0xab);
      return bytes;
    });
    expect(nonce).toBe("ab".repeat(16));
  });

  it("produces distinct nonces from the platform source", () => {
    expect(generateAlephNonce()).toMatch(/^[0-9a-f]{32}$/u);
    expect(generateAlephNonce()).not.toBe(generateAlephNonce());
  });
});

describe("createAlephNonceStore", () => {
  it("persists the request before the caller sends it", () => {
    const storage = memoryStorage();
    const store = createAlephNonceStore(storage, () => 1000);
    const pending = store.begin("update", BODY);
    const raw = storage.getItem("aleph-update-pending");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({
      nonce: pending.nonce,
      operation: "update",
      sentAt: 1000,
      body: BODY,
    });
  });

  it("returns the identical nonce and body on a retry while unresolved", () => {
    const storage = memoryStorage();
    const first = createAlephNonceStore(storage, () => 1000).begin(
      "update",
      BODY,
    );
    const second = createAlephNonceStore(storage, () => 5000).begin("update", {
      ...BODY,
      interrupt: true,
    });
    expect(second.nonce).toBe(first.nonce);
    expect(second.body).toEqual(BODY);
    expect(second.sentAt).toBe(1000);
  });

  it("issues a new nonce only after the stored one resolves", () => {
    const store = createAlephNonceStore(memoryStorage(), () => 1000);
    const first = store.begin("update", BODY);
    store.resolve();
    expect(store.read()).toBeNull();
    expect(store.begin("update", BODY).nonce).not.toBe(first.nonce);
  });

  it("ignores corrupt stored data", () => {
    const storage = memoryStorage();
    storage.setItem("aleph-update-pending", "{not json");
    const store = createAlephNonceStore(storage, () => 1000);
    expect(store.read()).toBeNull();
    expect(store.begin("recover", { confirm: "recover" }).operation).toBe(
      "recover",
    );
  });

  it("records a single resend", () => {
    const store = createAlephNonceStore(memoryStorage(), () => 1000);
    store.begin("update", BODY);
    store.markResent();
    expect(store.read()?.resent).toBe(true);
  });
});

describe("evaluateAlephPending", () => {
  const pending = {
    nonce: "a".repeat(32),
    operation: "update" as const,
    body: BODY,
    sentAt: 0,
    resent: false,
  };

  it("waits on queued and running runs", () => {
    expect(evaluateAlephPending(pending, "queued", 1000)).toBe("wait");
    expect(evaluateAlephPending(pending, "running", 1000)).toBe("wait");
    expect(evaluateAlephPending(pending, "recovering", 1000)).toBe("wait");
  });

  it("resolves on every terminal state", () => {
    for (const state of [
      "succeeded",
      "aborted",
      "rolled-back",
      "recovery-incomplete",
      "refused",
      "unknown",
    ] as const) {
      expect(evaluateAlephPending(pending, state, 1000)).toBe("resolved");
    }
  });

  it("waits on not-found before the resend threshold", () => {
    expect(
      evaluateAlephPending(pending, "not-found", ALEPH_NONCE_RESEND_MS - 1),
    ).toBe("wait");
  });

  it("resends once after the threshold", () => {
    expect(
      evaluateAlephPending(pending, "not-found", ALEPH_NONCE_RESEND_MS),
    ).toBe("resend");
    expect(
      evaluateAlephPending(
        { ...pending, resent: true },
        "not-found",
        ALEPH_NONCE_RESEND_MS,
      ),
    ).toBe("wait");
  });

  it("reports unknown after 55 minutes without an outcome, never success", () => {
    expect(
      evaluateAlephPending(pending, "not-found", ALEPH_NONCE_UNKNOWN_MS),
    ).toBe("outcome-unknown");
    expect(
      evaluateAlephPending(pending, "running", ALEPH_NONCE_UNKNOWN_MS),
    ).toBe("outcome-unknown");
    expect(ALEPH_NONCE_UNKNOWN_MS).toBe(55 * 60 * 1000);
  });

  it("tells the owner how to look the outcome up", () => {
    expect(alephOutcomeUnknownMessage("c".repeat(32))).toBe(
      `Outcome unknown: run \`aleph-update status ${"c".repeat(32)}\` (root shell)`,
    );
  });
});
