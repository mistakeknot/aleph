const THREAD_HOSTING_SEGMENTS = ["threads", "webview"];

export function shouldFollowThreadOpen(pathname: string): boolean {
  const segments = pathname.split("/");
  return !THREAD_HOSTING_SEGMENTS.some((segment) => segments.includes(segment));
}
