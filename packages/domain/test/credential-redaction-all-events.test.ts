import { describe, expect, it } from "vitest";
import {
  REDACTED_ENV_VALUE,
  parseStoredThreadEvent,
  redactCredentialsInJsonLine,
  redactEventDataForType,
  redactEventDataJsonForType,
  threadScope,
} from "../src/index.js";

const SECRET = "synthetic-review-token-1234";

function envEntry(name: string, value: string) {
  return { entries: [{ name, source: "shell", value }] };
}

describe("embedded credentials in non-secret-named env entries", () => {
  const cases: Array<[string, string]> = [
    ["flag, space separated", `--api-key ${SECRET}`],
    ["flag, short token", `--token ${SECRET} --verbose`],
    ["flag, quoted with space", `--api-key "${SECRET}"`],
    ["flag, quoted assignment", `--api-key="${SECRET}"`],
    ["shell quoted assignment", `KEY='${SECRET}' run`],
    ["embedded JSON", `{"CODEX_POOL_AUTH_TOKEN":"${SECRET}"}`],
    ["embedded JSON apiKey", `{"a":1,"apiKey": "${SECRET}","b":2}`],
    ["escaped embedded JSON", `{\\"password\\":\\"${SECRET}\\"}`],
    ["query passphrase", `https://x.test/p?passphrase=${SECRET}&a=1`],
    ["query sig", `https://x.test/p?a=1&sig=${SECRET}`],
    ["query signature", `https://x.test/p?signature=${SECRET}`],
    ["query access_token", `https://x.test/p?access_token=${SECRET}`],
    ["query api_key", `https://x.test/p?api_key=${SECRET}`],
    ["query key", `https://x.test/p?key=${SECRET}`],
    ["query secret", `https://x.test/p?secret=${SECRET}`],
    ["Cookie header", `Cookie: session=${SECRET}; other=2`],
    ["Set-Cookie header", `Set-Cookie: session=${SECRET}; HttpOnly`],
    ["Authorization header", `Authorization: Token ${SECRET}`],
    ["X-Api-Key header", `X-Api-Key: ${SECRET}`],
    ["Bearer", `curl -H 'Authorization: Bearer ${SECRET}'`],
  ];

  for (const [label, value] of cases) {
    it(`redacts ${label} when it is the only occurrence`, () => {
      const out = JSON.stringify(
        redactEventDataForType(
          "provider.env-resolved",
          envEntry("SOME_FLAGS", value),
        ),
      );
      expect(out).not.toContain(SECRET);
      expect(out).toContain("SOME_FLAGS");
      // idempotent
      expect(
        JSON.stringify(
          redactEventDataForType("provider.env-resolved", JSON.parse(out)),
        ),
      ).toBe(out);
    });
  }

  it("keeps non-secret values intact", () => {
    const data = envEntry("PATH", "/usr/bin:/bin --verbose");
    expect(redactEventDataForType("provider.env-resolved", data)).toEqual(data);
  });
});

describe("all-event-type credential redaction", () => {
  it("scrubs provider/warning and provider/error text", () => {
    for (const type of ["provider/warning", "provider/error"]) {
      const out = redactEventDataForType(type, {
        message: `request failed: Authorization: Bearer ${SECRET}`,
        details: `retry with --api-key ${SECRET}`,
        code: "bad-request",
      });
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(out.code).toBe("bad-request");
    }
  });

  it("redacts legacy client/thread/start request.params.options.envVars by key", () => {
    const data = {
      request: {
        params: {
          options: {
            model: "m",
            envVars: {
              CODEX_POOL_AUTH_TOKEN: SECRET,
              MY_API_KEY: SECRET,
              PATH: "/usr/bin",
            },
          },
        },
      },
    };
    const out = redactEventDataForType("client/thread/start", data);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.request.params.options.envVars.PATH).toBe("/usr/bin");
    expect(out.request.params.options.model).toBe("m");
  });

  it("redacts provider/unhandled raw wrappers with nested env maps", () => {
    const data = {
      method: "x",
      rawEvent: {
        method: "thread/start",
        params: {
          env: { SOME_SECRET: SECRET, HOME: "/home/u" },
          headers: { Authorization: `Bearer ${SECRET}`, Accept: "json" },
          nested: [{ environment: { AUTH_HEADER: SECRET } }],
        },
      },
    };
    const out = redactEventDataForType("provider/unhandled", data);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.rawEvent.params.env.HOME).toBe("/home/u");
    expect(out.rawEvent.params.headers.Accept).toBe("json");
  });

  it("redacts env/headers maps in content-bearing event types without touching text", () => {
    const data = {
      text: "the token budget is exhausted: key: value",
      item: { env: { API_TOKEN: SECRET }, accessToken: "customer-field" },
      tokenUsage: { inputTokens: 5, model: "m" },
    };
    const out = redactEventDataForType("item/completed", data);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.text).toBe(data.text);
    expect(out.tokenUsage).toEqual(data.tokenUsage);
    // Secret-named keys outside credential containers are tool data.
    expect(out.item.accessToken).toBe("customer-field");
  });

  it("cross-references a leaked secret into other strings of the payload", () => {
    const out = redactEventDataForType("provider/warning", {
      env: { API_TOKEN: SECRET },
      message: `oops ${SECRET} shown`,
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("returns the same object when nothing needs redaction and does not mutate input", () => {
    const clean = { message: "all good", n: 1 };
    expect(redactEventDataForType("provider/warning", clean)).toBe(clean);
    const dirty = { env: { API_TOKEN: SECRET } };
    redactEventDataForType("provider/warning", dirty);
    expect(dirty.env.API_TOKEN).toBe(SECRET);
  });

  it("fails closed on pathologically deep payloads", () => {
    let deep: Record<string, unknown> = { leaf: SECRET };
    for (let i = 0; i < 200; i += 1) deep = { child: deep };
    const out = redactEventDataForType("provider/unhandled", deep);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("redacts the JSON string variant for any type", () => {
    const json = JSON.stringify({ message: `Authorization: Bearer ${SECRET}` });
    expect(redactEventDataJsonForType("provider/error", json)).not.toContain(
      SECRET,
    );
    expect(redactEventDataJsonForType("provider/error", "not json")).toBe(
      "not json",
    );
  });

  it("redacts legacy stored rows of other types on read decode", () => {
    const event = parseStoredThreadEvent({
      type: "provider/error",
      data: { message: `Authorization: Bearer ${SECRET}` },
      providerThreadId: "p",
      scope: threadScope(),
      threadId: "thr_1",
    });
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(JSON.stringify(event)).toContain(REDACTED_ENV_VALUE);
  });

  it("redacts launch env in a recorded JSON line by key only", () => {
    const line = JSON.stringify({
      method: "start",
      params: { options: { envVars: { CODEX_POOL_AUTH_TOKEN: SECRET } } },
      text: "token: keep me",
    });
    const out = redactCredentialsInJsonLine(line);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("token: keep me");
    expect(redactCredentialsInJsonLine("plain line")).toBe("plain line");
  });

  it("redacts content-type JSON only when a secret-named key or env map is present", () => {
    const clean = JSON.stringify({ delta: "token budget: x" });
    expect(redactEventDataJsonForType("item/agentMessage/delta", clean)).toBe(
      clean,
    );
    for (const raw of [
      JSON.stringify({ env: { API_TOKEN: SECRET } }),
      JSON.stringify({ item: { headers: { Authorization: SECRET } } }),
      `{"\\u0065nv":{"API_TOKEN":"${SECRET}"}}`,
    ]) {
      expect(redactEventDataJsonForType("item/completed", raw)).not.toContain(
        SECRET,
      );
    }
  });
});
