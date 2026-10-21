export function shouldFollowThreadOpen(pathname: string): boolean {
  return !pathname.split("/").includes("threads");
}
