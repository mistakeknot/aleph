import { describe, expect, it } from "vitest";
import {
  parseStoredThreadEvent,
  redactEventDataForType,
  redactEventDataJsonForType,
  redactThreadEventPayload,
  threadScope,
} from "../src/index.js";

/**
 * Round 11 (B+) characterization: do the four round-10 repro shapes get caught
 * when the secret is ALSO registered as a known secret (the Aho-Corasick layer
 * fed by secret-named keys)? Synthetic values only.
 *
 * `caught` is the recorded behaviour of the known-secret layer for the exact
 * text of the repro, on all four paths (object, JSON write helper, full-event
 * emit, legacy decoder). The tail of the secret must be absent from `details`.
 */
const TAIL = "synthtail-123456789xyz";
const HEAD = "prefix";

interface Repro {
  name: string;
  text: string;
  /** What the secret really is (what a shell or URL parser would see). */
  secret: string;
  /** Known-secret layer alone removes the tail (before variant expansion). */
  caught: boolean;
}

const REPROS: Repro[] = [
  {
    name: "P2-1 quote continuation (header)",
    text: `curl -H 'Cookie: ${HEAD}'${TAIL}`,
    secret: `${HEAD}${TAIL}`,
    caught: false,
  },
  {
    name: "P2-1 quote continuation (flag)",
    text: `bash -c 'run --token=${HEAD}'${TAIL}`,
    secret: `${HEAD}${TAIL}`,
    caught: false,
  },
  {
    name: "P2-2 marker prefix (assignment)",
    text: `TOKEN=[redacted]'${TAIL}'`,
    secret: TAIL,
    caught: true,
  },
  {
    name: "P2-2 marker prefix (flag)",
    text: `--token=[redacted]"${TAIL}"`,
    secret: TAIL,
    caught: true,
  },
  {
    name: "P2-3 escaped space delimiter",
    text: `--token=${HEAD}\\ ${TAIL}`,
    secret: `${HEAD} ${TAIL}`,
    caught: false,
  },
  {
    name: "P2-3 escaped comma delimiter",
    text: `TOKEN=${HEAD}\\,${TAIL}`,
    secret: `${HEAD},${TAIL}`,
    caught: false,
  },
  {
    name: "P2-4 URL userinfo, quote-split with whitespace",
    text: `https://user:${HEAD}' ${TAIL}'@host.example/x`,
    secret: `${HEAD} ${TAIL}`,
    caught: false,
  },
  {
    name: "P2-4 URL userinfo, fully quoted with whitespace",
    text: `'https://user:${HEAD} ${TAIL}@host.example/x'`,
    secret: `${HEAD} ${TAIL}`,
    caught: true,
  },
];

function detailsOnAllPaths(text: string, secret: string): string[] {
  const data = { category: "config", details: text, token: secret };
  const object = redactEventDataForType("provider/warning", data) as {
    details: string;
  };
  const json = JSON.parse(
    redactEventDataJsonForType("provider/warning", JSON.stringify(data)),
  ) as { details: string };
  const emitted = redactThreadEventPayload({
    type: "provider/warning",
    threadId: "thr_synthetic",
    providerThreadId: "synthetic-provider",
    scope: threadScope(),
    ...data,
  } as { type: string }) as unknown as { details: string };
  const decoded = parseStoredThreadEvent({
    type: "provider/warning",
    data,
    providerThreadId: "synthetic-provider",
    scope: threadScope(),
    threadId: "thr_synthetic",
  }) as unknown as { details: string };
  return [object.details, json.details, emitted.details, decoded.details];
}

describe("round 11 characterization: round-10 repros vs the known-secret layer", () => {
  for (const repro of REPROS) {
    it(`${repro.name}: ${repro.caught ? "caught" : "NOT caught"}`, () => {
      for (const details of detailsOnAllPaths(repro.text, repro.secret)) {
        expect(details.includes(TAIL), `${repro.name}: ${details}`).toBe(
          !repro.caught,
        );
      }
    });
  }
});
