import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onDiagnostic } from "@/lib/diagnostics";
import { armTrailingRefetchesForInFlightQueries } from "./reconnect-trailing-refetch";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("armTrailingRefetchesForInFlightQueries", () => {
  const clients: QueryClient[] = [];
  afterEach(() => {
    for (const client of clients) client.clear();
    clients.length = 0;
  });

  function setup() {
    const queryClient = new QueryClient();
    clients.push(queryClient);
    return queryClient;
  }

  it("refetches once after an in-flight fetch settles", async () => {
    const queryClient = setup();
    const first = deferred<string>();
    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue("fresh");
    const key = ["thread", "thr_a"];
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    armTrailingRefetchesForInFlightQueries({
      invalidate: (queryKey) => {
        void queryClient.invalidateQueries({ exact: true, queryKey });
      },
      queryCache: queryClient.getQueryCache(),
      queryKeys: [["thread"]],
    });
    first.resolve("stale");

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    expect(observer.getCurrentResult().data).toBe("fresh");
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    unsubscribe();
  });

  it("does nothing when no matching query is fetching", () => {
    const queryClient = setup();
    queryClient.setQueryData(["thread", "thr_a"], "x");
    const events: string[] = [];
    const off = onDiagnostic((event) => events.push(event.kind));
    armTrailingRefetchesForInFlightQueries({
      invalidate: (queryKey) => {
        void queryClient.invalidateQueries({ exact: true, queryKey });
      },
      queryCache: queryClient.getQueryCache(),
      queryKeys: [["thread"]],
    });
    off();
    expect(events).toEqual([]);
  });

  it("emits armed and dropped phases and drops when the query is removed", async () => {
    const queryClient = setup();
    const never = new Promise<string>(() => {});
    const key = ["thread", "thr_a"];
    queryClient
      .fetchQuery({ queryKey: key, queryFn: () => never })
      .catch(() => {});
    const phases: string[] = [];
    const off = onDiagnostic((event) => {
      if (event.kind === "reconnect-trailing-refetch") {
        phases.push(`${event.phase}:${event.queryName}:${event.subjectId}`);
      }
    });
    armTrailingRefetchesForInFlightQueries({
      invalidate: (queryKey) => {
        void queryClient.invalidateQueries({ exact: true, queryKey });
      },
      queryCache: queryClient.getQueryCache(),
      queryKeys: [["thread"]],
    });
    queryClient.removeQueries({ queryKey: key });
    off();
    expect(phases).toEqual(["armed:thread:thr_a", "dropped:thread:thr_a"]);
  });
});
