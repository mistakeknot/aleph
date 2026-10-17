import { describe, expect, it } from "vitest";
import {
  REDACTED_ENV_VALUE,
  isSecretEnvName,
  parseStoredThreadEvent,
  redactEventDataJsonForType,
  redactProviderEnvResolvedData,
  threadScope,
} from "../src/index.js";

const POOL_TOKEN = "synthetic-pool-token-0000";

function legacyEnvData() {
  return {
    entries: [
      { name: "PATH", source: "shell", value: "/usr/bin" },
      { name: "CODEX_POOL_AUTH_TOKEN", source: "shell", value: POOL_TOKEN },
      {
        name: "BB_ACCOUNT_POOL_PARENT_URL",
        source: "shell",
        value: `http://hub:${POOL_TOKEN}@127.0.0.1:9000`,
      },
      {
        name: "SOME_PROXY",
        source: { plugin: "p" },
        value: `http://user:hunter2hunter2@proxy.local/x?token=${POOL_TOKEN}`,
        reason: `copied from ${POOL_TOKEN}`,
      },
      {
        name: "CURL_FLAGS",
        source: "shell",
        value: "-H 'Authorization: Bearer synthetic-bearer-1111' --api-key=abc",
      },
      { name: "MASKED_ONE", source: { core: "machine-git" }, value: { masked: true } },
    ],
  };
}

describe("provider.env-resolved redaction", () => {
  it("matches secret env names conservatively", () => {
    for (const name of [
      "CODEX_POOL_AUTH_TOKEN",
      "BB_ACCOUNT_POOL_PARENT_TOKEN",
      "GITHUB_CLIENT_SECRET",
      "API_KEY",
      "DB_PASSWORD",
      "AWS_CREDENTIALS",
      "BEARER",
      "AUTH_PROXY_URL",
    ]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
    expect(isSecretEnvName("PATH")).toBe(false);
    expect(isSecretEnvName("BB_THREAD_ID")).toBe(false);
  });

  it("keeps names, replaces secret values and embedded secrets", () => {
    const redacted = redactProviderEnvResolvedData(legacyEnvData());
    const text = JSON.stringify(redacted);
    expect(text).not.toContain(POOL_TOKEN);
    expect(text).not.toContain("hunter2hunter2");
    expect(text).not.toContain("synthetic-bearer-1111");
    expect(text).not.toContain("abc");
    expect(redacted.entries.map((entry) => entry.name)).toEqual(
      legacyEnvData().entries.map((entry) => entry.name),
    );
    expect(redacted.entries[0]?.value).toBe("/usr/bin");
    expect(redacted.entries[1]?.value).toBe(REDACTED_ENV_VALUE);
    expect(redacted.entries[5]?.value).toEqual({ masked: true });
  });

  it("is idempotent and tolerates payloads without entries", () => {
    const once = redactProviderEnvResolvedData(legacyEnvData());
    expect(redactProviderEnvResolvedData(once)).toEqual(once);
    expect(redactProviderEnvResolvedData({ other: 1 })).toEqual({ other: 1 });
    expect(redactEventDataJsonForType("system/error", "{bad")).toBe("{bad");
    expect(redactEventDataJsonForType("provider.env-resolved", "{bad")).toBe(
      "{bad",
    );
  });

  it("redacts legacy stored rows when they are decoded", () => {
    const event = parseStoredThreadEvent({
      type: "provider.env-resolved",
      data: legacyEnvData(),
      providerThreadId: "provider-session",
      scope: threadScope(),
      threadId: "thr_synthetic",
    });
    expect(JSON.stringify(event)).not.toContain(POOL_TOKEN);
    expect(JSON.stringify(event)).toContain(REDACTED_ENV_VALUE);
  });
});
