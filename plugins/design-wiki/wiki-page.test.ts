import { describe, expect, it } from "vitest";
import {
  classifyClaimText,
  extractClaimMarkers,
  parseWikiPage,
  splitCardRefs,
} from "./wiki-page.js";

const RULED_CUJ = `---
id: cuj-boss
status: ruled
card: "ACME-144"
source: docs/plans/boss.md
updated: 2026-11-02
---

# Boss encounter

**Ruled — ACME-76/144:** Enter combat and clear three phases.

**Design choice — entry contract:** RUN opens a paused confirmation.

**Open:** Exact weakness values remain unresolved.
`;

const MIXED_REQ = `---
id: req-plans
status: design-choice
card: ""
source: docs/design/mods.md
updated: 2026-11-02
---

# Mods and plans

| Plan | Status |
|---|---|
| [One](https://example.com/one) | Design choice — historical plan. |
| [Two](https://example.com/two) | Open — proposed catalogue. |
`;

function withFrontMatter(lines: string[], title = "# Title\n"): string {
  return `---\n${lines.join("\n")}\n---\n\n${title}`;
}

const VALID_LINES = [
  "id: cuj-run",
  "status: open",
  'card: ""',
  "source: docs/run.md",
  "updated: 2026-11-03",
];

function errorOf(content: string, kind: "cuj" | "requirement" = "cuj") {
  const result = parseWikiPage({
    kind,
    path: `docs/wiki/src/${kind === "cuj" ? "cujs" : "requirements"}/x.md`,
    content,
  });
  if (result.ok) throw new Error("expected a parse error");
  return result.error;
}

describe("parseWikiPage", () => {
  it("parses a ruled CUJ page", () => {
    const result = parseWikiPage({
      kind: "cuj",
      path: "docs/wiki/src/cujs/boss.md",
      content: RULED_CUJ,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.page).toMatchObject({
      id: "cuj-boss",
      kind: "cuj",
      path: "docs/wiki/src/cujs/boss.md",
      title: "Boss encounter",
      status: "ruled",
      card: "ACME-144",
      source: "docs/plans/boss.md",
      updated: "2026-11-02",
    });
    expect(result.page.body.startsWith("# Boss encounter")).toBe(true);
  });

  it("accepts an empty card on a design-choice requirement page", () => {
    const result = parseWikiPage({
      kind: "requirement",
      path: "docs/wiki/src/requirements/plans.md",
      content: MIXED_REQ,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.page.card).toBeNull();
    expect(result.page.status).toBe("design-choice");
  });

  it("accepts CRLF line endings and a byte order mark", () => {
    const result = parseWikiPage({
      kind: "cuj",
      path: "docs/wiki/src/cujs/boss.md",
      content: `﻿${RULED_CUJ.replace(/\n/g, "\r\n")}`,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a page without front matter", () => {
    expect(errorOf("# Title\n\nbody\n").message).toMatch(/front matter/i);
  });

  it("rejects front matter that never closes", () => {
    expect(errorOf("---\nid: cuj-run\n# Title\n").message).toMatch(
      /front matter/i,
    );
  });

  it("rejects front matter that is not valid YAML", () => {
    expect(errorOf("---\nid: [unclosed\n---\n\n# T\n").message).toMatch(
      /front matter/i,
    );
  });

  it("rejects front matter that is not a mapping", () => {
    expect(errorOf("---\n- a\n- b\n---\n\n# T\n").message).toMatch(
      /front matter/i,
    );
  });

  it.each(["id", "status", "card", "source", "updated"])(
    "reports a missing %s field",
    (field) => {
      const lines = VALID_LINES.filter((line) => !line.startsWith(`${field}:`));
      expect(errorOf(withFrontMatter(lines)).message).toContain(field);
    },
  );

  it("rejects an unknown status", () => {
    const lines = VALID_LINES.map((line) =>
      line.startsWith("status:") ? "status: approved" : line,
    );
    expect(errorOf(withFrontMatter(lines)).message).toMatch(/status/);
  });

  it("rejects a ruled page without a card", () => {
    const lines = VALID_LINES.map((line) =>
      line.startsWith("status:") ? "status: ruled" : line,
    );
    expect(errorOf(withFrontMatter(lines)).message).toMatch(
      /ruled.*card|card.*ruled/i,
    );
  });

  it("rejects a card that is not a task key", () => {
    const lines = VALID_LINES.map((line) =>
      line.startsWith("card:") ? "card: not a key" : line,
    );
    expect(errorOf(withFrontMatter(lines)).message).toMatch(/card/);
  });

  it("rejects an id whose prefix does not match the directory", () => {
    expect(errorOf(withFrontMatter(VALID_LINES), "requirement").message).toMatch(
      /req-/,
    );
  });

  it("rejects an id that is not cuj-* or req-*", () => {
    const lines = VALID_LINES.map((line) =>
      line.startsWith("id:") ? "id: page-run" : line,
    );
    expect(errorOf(withFrontMatter(lines)).message).toMatch(/id/);
  });

  it.each(["2026-13-01", "2026-02-30", "11/03/2026", "2026-11-3"])(
    "rejects the updated value %s",
    (value) => {
      const lines = VALID_LINES.map((line) =>
        line.startsWith("updated:") ? `updated: "${value}"` : line,
      );
      expect(errorOf(withFrontMatter(lines)).message).toMatch(/updated/);
    },
  );

  it.each(["/etc/passwd", "../outside.md", "docs/run.txt", ""])(
    "rejects the source %j",
    (value) => {
      const lines = VALID_LINES.map((line) =>
        line.startsWith("source:") ? `source: "${value}"` : line,
      );
      expect(errorOf(withFrontMatter(lines)).message).toMatch(/source/);
    },
  );

  it("rejects unknown front matter keys", () => {
    expect(
      errorOf(withFrontMatter([...VALID_LINES, "owner: someone"])).message,
    ).toMatch(/owner/);
  });

  it("rejects a page with no H1 title", () => {
    expect(errorOf(withFrontMatter(VALID_LINES, "Just text\n")).message).toMatch(
      /title|H1/i,
    );
  });

  it("does not take a heading inside a code fence as the title", () => {
    const content = withFrontMatter(
      VALID_LINES,
      "```\n# Not a title\n```\n\n# Real title\n",
    );
    const result = parseWikiPage({
      kind: "cuj",
      path: "docs/wiki/src/cujs/run.md",
      content,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.page.title).toBe("Real title");
  });

  it("reports the page path and kind on an error", () => {
    const error = errorOf("# nothing\n");
    expect(error.path).toBe("docs/wiki/src/cujs/x.md");
    expect(error.kind).toBe("cuj");
  });
});

describe("classifyClaimText", () => {
  it.each([
    ["Ruled — ACME-76/144:", "ruled"],
    ["Design choice — entry contract:", "design-choice"],
    ["Design choice", "design-choice"],
    ["Open:", "open"],
    ["Open — approval pending", "open"],
    ["Ruled at the planning review", "ruled"],
  ] as const)("classifies %j as %s", (text, status) => {
    expect(classifyClaimText(text)?.status).toBe(status);
  });

  it.each(["Opening move", "Ruledout", "Designed", "An Open door", ""])(
    "ignores %j",
    (text) => {
      expect(classifyClaimText(text)).toBeNull();
    },
  );

  it("collects the card keys named in the marker", () => {
    expect(classifyClaimText("Ruled — ACME-76/144:")?.cards).toEqual([
      "ACME-76",
      "ACME-144",
    ]);
  });
});

describe("splitCardRefs", () => {
  it("returns plain text untouched", () => {
    expect(splitCardRefs("no keys here")).toEqual([
      { kind: "text", text: "no keys here" },
    ]);
  });

  it("splits a single key out of text", () => {
    expect(splitCardRefs("see ACME-144 now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "card", key: "ACME-144", text: "ACME-144" },
      { kind: "text", text: " now" },
    ]);
  });

  it("expands slash lists and ranges using the first prefix", () => {
    expect(splitCardRefs("ACME-145–149/168")).toEqual([
      { kind: "card", key: "ACME-145", text: "ACME-145" },
      { kind: "text", text: "–" },
      { kind: "card", key: "ACME-149", text: "149" },
      { kind: "text", text: "/" },
      { kind: "card", key: "ACME-168", text: "168" },
    ]);
  });

  it("ignores lowercase and bare numbers", () => {
    expect(splitCardRefs("acme-1 and PR 127")).toEqual([
      { kind: "text", text: "acme-1 and PR 127" },
    ]);
  });
});

describe("extractClaimMarkers", () => {
  it("finds bold claim markers with body line numbers", () => {
    const markers = extractClaimMarkers(
      "# T\n\n**Ruled — ACME-1:** a\n\n**Design choice — x:** b\n\n**Open:** c\n",
    );
    expect(markers.map((marker) => [marker.status, marker.line])).toEqual([
      ["ruled", 3],
      ["design-choice", 5],
      ["open", 7],
    ]);
    expect(markers[0]?.cards).toEqual(["ACME-1"]);
  });

  it("finds claim markers that start a table cell", () => {
    const markers = extractClaimMarkers(
      "| a | b |\n|---|---|\n| [One](https://x.test) | Design choice — plan. |\n| Two | Open — pending. |\n",
    );
    expect(markers.map((marker) => [marker.status, marker.line])).toEqual([
      ["design-choice", 3],
      ["open", 4],
    ]);
  });

  it("ignores markers inside code fences and ordinary bold text", () => {
    const markers = extractClaimMarkers(
      "```\n**Ruled — ACME-1:** nope\n```\n\n**Important:** text\n\nOpen season is not a marker.\n",
    );
    expect(markers).toEqual([]);
  });

  it("returns nothing for an empty body", () => {
    expect(extractClaimMarkers("")).toEqual([]);
  });
});
