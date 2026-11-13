import { parse } from "parse5";
type HeaderPair = [string, string];

export const MAX_ANNOTATION_HTML_BYTES = 1024 * 1024;

export function annotationHtmlEligible(
  headers: HeaderPair[],
  status: number,
): boolean {
  const get = (name: string) =>
    headers
      .filter(([key]) => key.toLowerCase() === name)
      .map(([, value]) => value)
      .join(",");
  const length = Number(get("content-length"));
  return (
    status === 200 &&
    /^text\/html(?:;\s*charset=utf-8)?$/i.test(get("content-type")) &&
    !get("content-encoding") &&
    !get("transfer-encoding") &&
    !get("content-range") &&
    !get("content-disposition") &&
    length > 0 &&
    length <= MAX_ANNOTATION_HTML_BYTES
  );
}

export function annotationHtml(
  headers: HeaderPair[],
  body: Buffer,
  script: string,
  status: number,
): { headers: HeaderPair[]; body: Buffer } | null {
  if (
    !annotationHtmlEligible(headers, status) ||
    body.length > MAX_ANNOTATION_HTML_BYTES
  )
    return null;
  const html = body.toString("utf8");
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find((node) => node.nodeName === "html");
  const bodyNode =
    root && "childNodes" in root
      ? root.childNodes.find((node) => node.nodeName === "body")
      : undefined;
  const offset =
    bodyNode && "tagName" in bodyNode
      ? bodyNode.sourceCodeLocation?.endTag?.startOffset
      : undefined;
  if (
    !Buffer.from(html).equals(body) ||
    /<meta\b[^>]*http-equiv/i.test(html) ||
    offset === undefined
  )
    return null;
  const policies = headers
    .filter(([key]) => key.toLowerCase() === "content-security-policy")
    .flatMap(([, value]) => value.split(","));
  let nonces: string[] | null = null;
  for (const policy of policies) {
    const directives = policy
      .split(";")
      .map((part) => part.trim().split(/\s+/));
    if (
      directives.some(
        ([name]) => name === "sandbox" || name === "require-trusted-types-for",
      )
    )
      return null;
    const sources =
      directives.find(([name]) => name === "script-src-elem") ??
      directives.find(([name]) => name === "script-src") ??
      directives.find(([name]) => name === "default-src");
    if (!sources) continue;
    const allowed = sources.flatMap(
      (source) => /^'nonce-([a-zA-Z0-9+/_=-]+)'$/.exec(source)?.slice(1) ?? [],
    );
    nonces =
      nonces === null
        ? allowed
        : nonces.filter((nonce) => allowed.includes(nonce));
    if (nonces.length === 0) return null;
  }
  const nonce = nonces?.[0];
  const tag = `<script${nonce ? ` nonce="${nonce}"` : ""}>${script.replace(/<\/script/gi, "<\\/script")}</script>`;
  const output = Buffer.from(html.slice(0, offset) + tag + html.slice(offset));
  const retained = headers.filter(
    ([key]) =>
      ![
        "content-length",
        "etag",
        "last-modified",
        "cache-control",
        "content-md5",
        "digest",
      ].includes(key.toLowerCase()),
  );
  return {
    headers: [
      ...retained,
      ["content-length", String(output.length)],
      ["cache-control", "private, no-store"],
    ],
    body: output,
  };
}
