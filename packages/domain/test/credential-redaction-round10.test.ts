import { describe, expect, it } from "vitest";
import {
  parseStoredThreadEvent,
  redactEventDataForType,
  redactEventDataJsonForType,
  redactThreadEventPayload,
  threadEventSchema,
  threadScope,
} from "../src/index.js";

const TAIL = "synthtail-123456789xyz";
const HEAD = "prefix";
const bs = (n: number) => "\\".repeat(n);

/** Every secret-named flag/assignment name the scanner knows. */
const NAMES = [
  "token",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "cookie",
  "signature",
  "authorization",
  "authentication",
  "apiKey",
  "api-key",
  "bearer",
  "auth",
  "oauth",
  "sig",
];

/** The `details` text after each of the four redaction paths (all idempotent). */
function paths(text: string): Record<string, string> {
  const data = { category: "config", details: text };
  const object = redactEventDataForType("provider/warning", data) as {
    details: string;
  };
  expect(redactEventDataForType("provider/warning", object), "object").toEqual(
    object,
  );
  const json = redactEventDataJsonForType(
    "provider/warning",
    JSON.stringify(data),
  );
  expect(redactEventDataJsonForType("provider/warning", json), "json").toEqual(
    json,
  );
  const event = {
    type: "provider/warning",
    threadId: "thr_synthetic",
    providerThreadId: "synthetic-provider",
    scope: threadScope(),
    ...data,
  };
  expect(threadEventSchema.safeParse(event).success).toBe(true);
  const emitted = redactThreadEventPayload(event as { type: string });
  expect(redactThreadEventPayload(emitted), "emit").toEqual(emitted);
  const decoded = parseStoredThreadEvent({
    type: "provider/warning",
    data,
    providerThreadId: "synthetic-provider",
    scope: threadScope(),
    threadId: "thr_synthetic",
  });
  const decodedAgain = parseStoredThreadEvent({
    type: "provider/warning",
    data: {
      category: "config",
      details: (decoded as { details: string }).details,
    },
    providerThreadId: "synthetic-provider",
    scope: threadScope(),
    threadId: "thr_synthetic",
  });
  expect(decodedAgain, "legacy").toEqual(decoded);
  return {
    object: object.details,
    json: (JSON.parse(json) as { details: string }).details,
    emit: (emitted as unknown as { details: string }).details,
    legacy: (decoded as { details: string }).details,
  };
}

function expectMasked(text: string, expected?: string): void {
  for (const [path, out] of Object.entries(paths(text))) {
    expect(out, `${path}: ${text}`).not.toContain(TAIL);
    expect(out, `${path}: ${text}`).not.toContain(HEAD);
    if (expected !== undefined) {
      expect(out, `${path}: ${text}`).toBe(expected);
    }
  }
}

describe("round 10: secret flag and assignment values are whole shell words", () => {
  it("masks the reviewer repro and its siblings in every path", () => {
    expectMasked(`--token=${HEAD}'${TAIL}'`, "--token=[redacted]");
    expectMasked(`--token ${HEAD}'${TAIL}'`, "--token [redacted]");
    expectMasked(`TOKEN=${HEAD}"${TAIL}"`, "TOKEN=[redacted]");
    expectMasked(`apiKey="${HEAD}"'${TAIL}'`, "apiKey=[redacted]");
    expectMasked(`--token "${HEAD}\\"${TAIL}"`, "--token [redacted]");
  });

  for (const name of NAMES) {
    for (const quote of ["'", '"']) {
      for (let depth = 0; depth <= 3; depth += 1) {
        const q = bs(depth) + quote;
        const inner = bs(depth + 1) + quote;
        it(`${name}: ${quote} escaped ${depth} deep, all separators and shapes`, () => {
          const values = [
            `${HEAD}${q}${TAIL}${q}`, // adjacent fragment
            `${HEAD}${q}${TAIL}`, // unterminated fragment
            `${q}${HEAD}${q}${q}${TAIL}${q}`, // several fragments
            `${q}${HEAD}${inner}${TAIL}${q}`, // escaped quote inside
            `${HEAD}${q}${TAIL} more words${q}`, // fragment with spaces
            `${HEAD}${q}a${q}${q}b${q}${TAIL}`, // fragments then plain tail
          ];
          for (const value of values) {
            for (const lead of ["", "run "]) {
              expectMasked(`${lead}--${name}=${value}`);
              expectMasked(`${lead}--${name} ${value}`);
              expectMasked(`${lead}${name}=${value}`);
              expectMasked(`${lead}${name.toUpperCase()}: ${value}`);
              expectMasked(`${lead}${name.toUpperCase()}=${value} next`);
            }
          }
        });
      }
    }
  }

  it("keeps masking a double-quoted and an unquoted value", () => {
    expectMasked(`--token "${HEAD}${TAIL}" next`, "--token [redacted] next");
    expectMasked(`--token ${HEAD}${TAIL} next`, "--token [redacted] next");
    expectMasked(`TOKEN='${HEAD}${TAIL}' next`, "TOKEN=[redacted] next");
  });

  it("masks multi-fragment values that continue after a closed fragment", () => {
    expectMasked(
      `--token=${HEAD}'a'"b"'${TAIL}' next`,
      "--token=[redacted] next",
    );
  });

  it("controls: a genuinely enclosing quote still keeps the text after it", () => {
    for (const depth of [0, 1, 2, 3]) {
      for (const quote of ["'", '"']) {
        const q = bs(depth) + quote;
        const tail = `${HEAD}${TAIL}`;
        for (const [text, expected] of [
          [
            `bash -c ${q}run --token=${tail}${q} NEXT`,
            `bash -c ${q}run --token=[redacted]${q} NEXT`,
          ],
          [
            `bash -c ${q}run --token ${tail}${q} NEXT`,
            `bash -c ${q}run --token [redacted]${q} NEXT`,
          ],
          [
            `bash -c ${q}run TOKEN=${tail}${q} NEXT`,
            `bash -c ${q}run TOKEN=[redacted]${q} NEXT`,
          ],
        ] as const) {
          for (const [path, out] of Object.entries(paths(text))) {
            expect(out, `${path}: ${text}`).toBe(expected);
          }
        }
      }
    }
  });

  it("controls: the other kind of quote inside an enclosing string is a fragment", () => {
    expectMasked(
      `bash -c 'run --token=${HEAD}"${TAIL}"' NEXT`,
      `bash -c 'run --token=[redacted]' NEXT`,
    );
    expectMasked(
      `bash -c "run --token=${HEAD}'${TAIL}'" NEXT`,
      `bash -c "run --token=[redacted]" NEXT`,
    );
  });

  it("controls: a closed value keeps text after it", () => {
    for (const [text, expected] of [
      [`--token "${TAIL}" NEXT`, "--token [redacted] NEXT"],
      [`--token '${TAIL}' NEXT`, "--token [redacted] NEXT"],
      [`TOKEN="${TAIL}" NEXT=1`, "TOKEN=[redacted] NEXT=1"],
      [`?sig=${TAIL}&NEXT=1`, "?sig=[redacted]&NEXT=1"],
      [`TOKEN=${TAIL},NEXT=1`, "TOKEN=[redacted],NEXT=1"],
    ] as const) {
      for (const [path, out] of Object.entries(paths(text))) {
        expect(out, `${path}: ${text}`).toBe(expected);
      }
    }
  });

  it("controls: non-secret names are untouched, quotes and all", () => {
    for (const text of [
      `--author=ada'x'tail`,
      `--design 'x'tail`,
      `author="a"'b' design=c'd'`,
      `--verbose --output='a b'c`,
    ]) {
      for (const [path, out] of Object.entries(paths(text))) {
        expect(out, `${path}: ${text}`).toBe(text);
      }
    }
  });

  it("a multi-line quoted value is masked through its closing quote", () => {
    expectMasked(
      `--token "${HEAD}\n${TAIL}\n-----END" NEXT`,
      "--token [redacted] NEXT",
    );
  });

  it("an unterminated quote masks to the end of the line only", () => {
    expectMasked(`--token "${HEAD}${TAIL}\nNEXT`, "--token [redacted]\nNEXT");
    expectMasked(`TOKEN=${HEAD}'${TAIL}\nNEXT`, "TOKEN=[redacted]\nNEXT");
  });

  it("an env-style prefix hides nothing: --env=KEY=value, -e=KEY=value", () => {
    expectMasked(
      `docker run --env=API_TOKEN=${HEAD}'${TAIL}'`,
      "docker run --env=API_TOKEN=[redacted]",
    );
    expectMasked(
      `docker run -e=API_TOKEN=${HEAD}"${TAIL}"`,
      "docker run -e=API_TOKEN=[redacted]",
    );
    expectMasked(
      `docker run -e API_TOKEN=${HEAD}'${TAIL}'`,
      "docker run -e API_TOKEN=[redacted]",
    );
    expectMasked(
      `--build-arg=PASSWORD=${HEAD}'${TAIL}'`,
      "--build-arg=PASSWORD=[redacted]",
    );
  });
});

describe("round 10: other secret shapes in free text take the same rule", () => {
  it("bearer text outside headers masks an adjacent quoted fragment", () => {
    expectMasked(`Bearer ${HEAD}'${TAIL}'`, "Bearer [redacted]");
    expectMasked(`Bearer ${HEAD}"${TAIL}" next`, "Bearer [redacted] next");
    expectMasked(`Basic ${HEAD}'${TAIL}`, "Basic [redacted]");
    expectMasked(
      `echo Bearer ${HEAD}${bs(1)}"${TAIL}${bs(1)}"`,
      "echo Bearer [redacted]",
    );
    for (const [path, out] of Object.entries(
      paths(`bash -c 'echo Bearer ${HEAD}${TAIL}' NEXT`),
    )) {
      expect(out, path).toBe("bash -c 'echo Bearer [redacted]' NEXT");
    }
  });

  it("strong bearer in tool text masks an adjacent quoted fragment", () => {
    const text = `Bearer ${HEAD}${HEAD}${HEAD}'${TAIL}'`;
    const out = redactEventDataForType("item/completed", {
      item: { type: "commandExecution", id: "x", aggregatedOutput: text },
    }) as { item: { aggregatedOutput: string } };
    expect(out.item.aggregatedOutput).toBe("Bearer [redacted]");
  });

  it("URL userinfo with an @ in the password is masked to the last @", () => {
    expectMasked(
      `https://user:${HEAD}@${TAIL}@host.example/x`,
      "https://[redacted]@host.example/x",
    );
    expectMasked(
      `see https://user:${HEAD}'${TAIL}'@host.example/x next`,
      "see https://[redacted]@host.example/x next",
    );
  });

  it("an unterminated JSON string value is masked to the end of the line", () => {
    expectMasked(`{"token": "${HEAD} ${TAIL}`, `{"token": "[redacted]"`);
  });

  for (let depth = 1; depth <= 3; depth += 1) {
    it(`an escaped JSON value with a deeper escaped quote, depth ${depth}`, () => {
      const q = bs(depth) + '"';
      const inner = bs(depth + 1) + '"';
      expectMasked(`${q}token${q}:${q}${HEAD}${inner}${TAIL}${q}`);
      expectMasked(`${q}token${q}:${q}${HEAD}${inner}${TAIL}`);
      expectMasked(`{${q}token${q}: ${q}${HEAD} ${TAIL}`);
    });
  }

  it("a genuine escaped JSON value keeps what follows its closing quote", () => {
    for (const [path, out] of Object.entries(
      paths(`{\\"token\\":\\"${HEAD}${TAIL}\\",\\"next\\":\\"NEXT\\"}`),
    )) {
      expect(out, path).toContain("NEXT");
      expect(out, path).not.toContain(TAIL);
    }
  });
});
