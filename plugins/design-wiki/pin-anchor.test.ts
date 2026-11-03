import { describe, expect, it } from "vitest";
import { extractClaimMarkers } from "./claims.js";
import {
  claimTargetAt,
  resolvePinAnchor,
  verifyClaimTarget,
  type PinAnchorInput,
} from "./pin-anchor.js";
import type { WikiDiscovery } from "./wiki-discovery.js";
import type { WikiPage, WikiPageError } from "./wiki-types.js";

function pageOf(
  id: string,
  body: string,
  path = `docs/wiki/src/cujs/${id}.md`,
): WikiPage {
  return {
    id,
    kind: "cuj",
    path,
    title: id,
    status: "open",
    card: null,
    source: "test",
    updated: "2026-11-01",
    body,
    claims: extractClaimMarkers(body),
  };
}

function discoveryOf(
  pages: WikiPage[],
  options: {
    errors?: WikiPageError[];
    state?: "ready" | "empty" | "unavailable";
  } = {},
): WikiDiscovery {
  const errors = options.errors ?? [];
  return {
    pages,
    list: {
      state:
        options.state ??
        (pages.length === 0 && errors.length === 0 ? "empty" : "ready"),
      message: null,
      pages: pages.map(
        ({ body: _body, claims: _claims, ...summary }) => summary,
      ),
      errors,
    },
  };
}

function claimPin(page: WikiPage, claimIndex: number): PinAnchorInput {
  const target = claimTargetAt(page, claimIndex);
  if (target === null) throw new Error("no claim");
  return { pageId: page.id, sourcePath: page.path, claim: target };
}

const BASE = [
  "# T",
  "",
  "**Open: first question**",
  "text",
  "**Ruled: second**",
  "",
].join("\n");

describe("claim identity", () => {
  it("describes a claim by label, line text, ordinal and group size", () => {
    const page = pageOf("a", BASE);
    expect(claimTargetAt(page, 0)).toEqual({
      label: "Open: first question",
      context: "**Open: first question**",
      ordinal: 0,
      groupSize: 1,
    });
  });

  it("strips carriage returns and trims the context", () => {
    const page = pageOf("a", "  **Open: q**  \r\nrest\r\n");
    expect(claimTargetAt(page, 0)?.context).toBe("**Open: q**");
  });

  it("counts ordinal and group size among byte-identical claims only", () => {
    const page = pageOf(
      "a",
      [
        "**Open: x**",
        "**Ruled: y**",
        "**Open: x**",
        "**Open: x** tail",
        "",
      ].join("\n"),
    );
    expect(claimTargetAt(page, 0)).toMatchObject({ ordinal: 0, groupSize: 2 });
    expect(claimTargetAt(page, 2)).toMatchObject({ ordinal: 1, groupSize: 2 });
    expect(claimTargetAt(page, 3)).toMatchObject({ ordinal: 0, groupSize: 1 });
  });

  it("returns null for an index outside the claims", () => {
    expect(claimTargetAt(pageOf("a", BASE), 9)).toBeNull();
  });
});

describe("verifyClaimTarget", () => {
  it("accepts a claim that matches the page", () => {
    const page = pageOf("a", BASE);
    const target = claimTargetAt(page, 1);
    expect(target && verifyClaimTarget(page, target)).toEqual({ ok: true });
  });

  it("rejects a claim that is not on the page", () => {
    const page = pageOf("a", BASE);
    expect(
      verifyClaimTarget(page, {
        label: "Open: nope",
        context: "x",
        ordinal: 0,
        groupSize: 1,
      }),
    ).toEqual({ ok: false, reason: "unknown-claim" });
  });

  it("rejects a stale composer when an identical claim was inserted", () => {
    const before = pageOf("a", "**Open: x**\n");
    const target = claimTargetAt(before, 0);
    const after = pageOf("a", "**Open: x**\n**Open: x**\n");
    expect(target && verifyClaimTarget(after, target)).toEqual({
      ok: false,
      reason: "stale-claim",
    });
  });

  it("rejects an ordinal at or beyond the group size", () => {
    const page = pageOf("a", BASE);
    expect(
      verifyClaimTarget(page, {
        label: "Open: first question",
        context: "**Open: first question**",
        ordinal: 1,
        groupSize: 1,
      }),
    ).toEqual({ ok: false, reason: "stale-claim" });
  });
});

describe("resolvePinAnchor: claims", () => {
  it("keeps a page pin on the page", () => {
    const page = pageOf("a", BASE);
    expect(
      resolvePinAnchor(
        { pageId: "a", sourcePath: page.path, claim: null },
        discoveryOf([page]),
      ),
    ).toEqual({ state: "page" });
  });

  it("follows a sole claim moved down the page unchanged", () => {
    const before = pageOf("a", BASE);
    const pin = claimPin(before, 0);
    const after = pageOf(
      "a",
      [
        "# T",
        "",
        "more",
        "more",
        "",
        "**Open: first question**",
        "text",
        "",
      ].join("\n"),
    );
    expect(resolvePinAnchor(pin, discoveryOf([after]))).toMatchObject({
      state: "claim",
      line: 6,
    });
  });

  it("detaches when the text after the claim is edited", () => {
    const before = pageOf("a", "**Open: q** original\n");
    const pin = claimPin(before, 0);
    const after = pageOf("a", "**Open: q** edited\n");
    expect(resolvePinAnchor(pin, discoveryOf([after]))).toEqual({
      state: "detached",
      reason: "claim-changed",
    });
  });

  it("does not adopt a surviving claim with the same label on a different line", () => {
    const before = pageOf("a", "**Open: q** one\n**Open: q** two\n");
    const pin = claimPin(before, 0);
    const after = pageOf("a", "**Open: q** two\n");
    expect(resolvePinAnchor(pin, discoveryOf([after]))).toEqual({
      state: "detached",
      reason: "claim-changed",
    });
  });

  it("detaches when identical lines were inserted before", () => {
    const before = pageOf("a", "**Open: x**\n**Open: x**\n");
    const pin = claimPin(before, 1);
    const after = pageOf("a", "**Open: x**\n**Open: x**\n**Open: x**\n");
    expect(resolvePinAnchor(pin, discoveryOf([after]))).toEqual({
      state: "detached",
      reason: "ambiguous",
    });
  });

  it("keeps identical claims by position when nothing else changed", () => {
    const before = pageOf("a", "**Open: x**\nmid\n**Open: x**\n");
    const pin = claimPin(before, 1);
    const after = pageOf("a", "**Open: x**\nmiddle\n**Open: x**\n");
    expect(resolvePinAnchor(pin, discoveryOf([after]))).toMatchObject({
      state: "claim",
      line: 3,
      identical: true,
    });
  });

  it("keeps a claim when unrelated claims are inserted around it", () => {
    const before = pageOf("a", BASE);
    const pin = claimPin(before, 1);
    const after = pageOf("a", `**Open: new**\n${BASE}**Ruled: later**\n`);
    expect(resolvePinAnchor(pin, discoveryOf([after]))).toMatchObject({
      state: "claim",
    });
  });

  it("detaches when the claim is deleted", () => {
    const before = pageOf("a", BASE);
    const pin = claimPin(before, 1);
    const after = pageOf("a", "# T\n\n**Open: first question**\n");
    expect(resolvePinAnchor(pin, discoveryOf([after]))).toEqual({
      state: "detached",
      reason: "claim-changed",
    });
  });
});

describe("resolvePinAnchor: missing pages", () => {
  const pin: PinAnchorInput = {
    pageId: "gone",
    sourcePath: "docs/wiki/src/cujs/gone.md",
    claim: null,
  };
  const other = pageOf("other", BASE);

  it("detaches when the page is gone and discovery is clean", () => {
    expect(resolvePinAnchor(pin, discoveryOf([other]))).toEqual({
      state: "detached",
      reason: "page-missing",
    });
  });

  it("detaches after the last page is deleted", () => {
    expect(resolvePinAnchor(pin, discoveryOf([], { state: "empty" }))).toEqual({
      state: "detached",
      reason: "page-missing",
    });
  });

  it("is unverified when discovery is unavailable", () => {
    const discovery = discoveryOf([], { state: "unavailable" });
    expect(resolvePinAnchor(pin, discovery)).toMatchObject({
      state: "unverified",
    });
  });

  it("is unverified when any file failed to read, even for another path", () => {
    const discovery = discoveryOf([other], {
      errors: [
        {
          kind: "cuj",
          path: "docs/wiki/src/cujs/bad.md",
          message: "Could not read page: boom",
        },
      ],
    });
    expect(resolvePinAnchor(pin, discovery)).toMatchObject({
      state: "unverified",
    });
  });

  it("names the error on the pin's own source path", () => {
    const discovery = discoveryOf([other], {
      errors: [
        {
          kind: "cuj",
          path: "docs/wiki/src/cujs/gone.md",
          message: "Could not read page: boom",
        },
      ],
    });
    expect(resolvePinAnchor(pin, discovery)).toEqual({
      state: "unverified",
      reason: "Could not read page: boom",
    });
  });

  it("is unverified when a listing failed for one kind", () => {
    const discovery = discoveryOf([other], {
      errors: [
        {
          kind: "requirement",
          path: "docs/wiki/src/requirements",
          message: "Could not list",
        },
      ],
    });
    expect(resolvePinAnchor(pin, discovery)).toMatchObject({
      state: "unverified",
    });
  });

  it("is unverified when an earlier-sorted duplicate of the pinned id appears", () => {
    const original = pageOf("dup", "**Open: q**\n", "docs/wiki/src/cujs/b.md");
    const claimOnOriginal = claimPin(original, 0);
    const earlier = pageOf("dup", "**Open: q**\n", "docs/wiki/src/cujs/a.md");
    const discovery = discoveryOf([earlier], {
      errors: [
        {
          kind: "cuj",
          path: "docs/wiki/src/cujs/b.md",
          message: "Duplicate page id: dup",
          pageId: "dup",
        },
      ],
    });
    expect(resolvePinAnchor(claimOnOriginal, discovery)).toMatchObject({
      state: "unverified",
    });
  });

  it("is unverified when the page is missing and a duplicate error exists", () => {
    const discovery = discoveryOf([other], {
      errors: [
        {
          kind: "cuj",
          path: "docs/wiki/src/cujs/z.md",
          message: "Duplicate page id: x",
          pageId: "x",
        },
      ],
    });
    expect(resolvePinAnchor(pin, discovery)).toMatchObject({
      state: "unverified",
    });
  });

  it("still resolves a surviving page while another page has a parse error", () => {
    const survivor = pageOf("a", BASE);
    const discovery = discoveryOf([survivor], {
      errors: [
        {
          kind: "cuj",
          path: "docs/wiki/src/cujs/bad.md",
          message: "Invalid front matter",
        },
      ],
    });
    expect(
      resolvePinAnchor(
        { pageId: "a", sourcePath: survivor.path, claim: null },
        discovery,
      ),
    ).toEqual({ state: "page" });
  });
});
