import type { Query, QueryCache, QueryKey } from "@tanstack/react-query";
import { toDiagnosticQueryName } from "@bb/desktop-contract";
import { emitDiagnostic, toDiagnosticId } from "@/lib/diagnostics";

type TrailingPhase = "armed" | "fired" | "dropped";

interface ArmTrailingRefetchesArgs {
  invalidate: (queryKey: QueryKey) => void;
  queryCache: QueryCache;
  queryKeys: readonly QueryKey[];
}

function emitPhase(query: Query, phase: TrailingPhase): void {
  emitDiagnostic(() => ({
    kind: "reconnect-trailing-refetch",
    phase,
    queryName: toDiagnosticQueryName(query.queryKey[0]),
    subjectId: toDiagnosticId(query.queryKey[1]),
  }));
}

export function armTrailingRefetchesForInFlightQueries({
  invalidate,
  queryCache: cache,
  queryKeys,
}: ArmTrailingRefetchesArgs): void {
  const armed = new Set<Query>();
  for (const queryKey of queryKeys) {
    for (const query of cache.findAll({ queryKey })) {
      if (query.state.fetchStatus === "fetching") {
        armed.add(query);
      }
    }
  }
  if (armed.size === 0) {
    return;
  }
  for (const query of armed) {
    emitPhase(query, "armed");
  }
  const unsubscribe = cache.subscribe((event) => {
    if (!armed.has(event.query)) {
      return;
    }
    const { query } = event;
    if (event.type === "removed") {
      armed.delete(query);
      emitPhase(query, "dropped");
    } else if (query.state.fetchStatus !== "fetching") {
      armed.delete(query);
      emitPhase(query, "fired");
      invalidate(query.queryKey);
    }
    if (armed.size === 0) {
      unsubscribe();
    }
  });
}
