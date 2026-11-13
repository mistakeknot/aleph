import { describe, expect, it } from "vitest";
import { annotationHtml } from "./annotation-html.js";
import { JSDOM } from "jsdom";

it("inserts at the parsed body end without changing scripts or trailing raw text", () => {
  for (const suffix of [
    "<!-- </body> -->",
    '<script>window.trailing = "</body>";</script>',
    "<textarea></body></textarea>",
  ]) {
    const html =
      '<!doctype html><html><body><!-- </body> --><script>window.nativeRan = "</body>";</script></body>' +
      suffix +
      "</html>";
    const result = annotationHtml(
      [
        ["content-type", "text/html"],
        ["content-length", String(Buffer.byteLength(html))],
      ],
      Buffer.from(html),
      "window.overlayRan = true;",
      200,
    );
    expect(result).not.toBeNull();
    expect(
      result!.body
        .toString()
        .replace("<script>window.overlayRan = true;</script>", ""),
    ).toBe(html);
    const dom = new JSDOM(result!.body.toString(), {
      runScripts: "dangerously",
    });
    expect(dom.window.nativeRan).toBe("</body>");
    expect(dom.window.overlayRan).toBe(true);
    dom.window.close();
  }
});

describe("annotation HTML eligibility", () => {
  const html = Buffer.from("<!doctype html><html><body>Preview</body></html>");
  const headers = [
    ["content-type", "text/html; charset=utf-8"],
    ["content-length", String(html.length)],
  ] as [string, string][];
  it("leaves encoded, streamed, partial and meta-policy documents unchanged", () => {
    for (const extra of [
      ["content-encoding", "gzip"],
      ["transfer-encoding", "chunked"],
      ["content-range", "bytes 0-10/20"],
    ]) {
      expect(
        annotationHtml(
          [...headers, extra as [string, string]],
          html,
          "boot()",
          200,
        ),
      ).toBeNull();
    }
    expect(
      annotationHtml(
        headers,
        Buffer.from(
          '<meta http-equiv="Content-Security-Policy" content="script-src none">',
        ),
        "boot()",
        200,
      ),
    ).toBeNull();
    expect(annotationHtml(headers, html, "boot()", 206)).toBeNull();
  });
  it("never adds permission to a restrictive CSP", () => {
    expect(
      annotationHtml(
        [...headers, ["content-security-policy", "script-src 'none'"]],
        html,
        "boot()",
        200,
      ),
    ).toBeNull();
  });
  it("uses an existing nonce without changing CSP", () => {
    const policy =
      "default-src 'self'; script-src 'nonce-abc123'; style-src 'none'";
    const result = annotationHtml(
      [...headers, ["content-security-policy", policy]],
      html,
      "boot()",
      200,
    );
    expect(result?.body.toString()).toContain(
      '<script nonce="abc123">boot()</script>',
    );
    expect(result?.headers).toContainEqual(["content-security-policy", policy]);
    expect(result?.headers).toContainEqual([
      "cache-control",
      "private, no-store",
    ]);
  });
  it("rejects conflicting policies and non HTML", () => {
    expect(
      annotationHtml(
        [
          ...headers,
          [
            "content-security-policy",
            "script-src 'nonce-a', script-src 'nonce-b'",
          ],
        ],
        html,
        "boot()",
        200,
      ),
    ).toBeNull();
    expect(
      annotationHtml(
        [["content-type", "application/json"]],
        html,
        "boot()",
        200,
      ),
    ).toBeNull();
  });
});
