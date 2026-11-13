import { describe, expect, it } from "vitest";
import { annotationHtml } from "./annotation-html.js";

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
