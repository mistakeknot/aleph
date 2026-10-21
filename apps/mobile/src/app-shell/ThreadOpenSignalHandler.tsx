import { usePathname, useRouter } from "expo-router";
import { useEffect } from "react";
import { webViewShellHref } from "@/screens/shell/hrefs";
import { useProfiles } from "./ProfilesProvider";
import { shouldFollowThreadOpen } from "./thread-open-follow";

export function ThreadOpenSignalHandler() {
  const { connection } = useProfiles();
  const router = useRouter();
  const pathname = usePathname();
  const realtime = connection?.client.realtime ?? null;
  useEffect(() => {
    if (!realtime) return;
    return realtime.onThreadOpen((signal) => {
      if (!shouldFollowThreadOpen(pathname)) return;
      router.push(webViewShellHref({ path: `/threads/${signal.threadId}` }));
    });
  }, [realtime, router, pathname]);
  return null;
}
