import type { RetiredUserPostsMode } from "@bb/server-contract";

export function retiredUserPostsMode(): RetiredUserPostsMode {
  return process.env.ALEPH_RETIRED_USER_POSTS === "refuse"
    ? "refuse"
    : "redirect";
}
