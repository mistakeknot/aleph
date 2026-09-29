import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { DiagnosticPayload } from "@/lib/diagnostics";
import { toDiagnosticQueryName } from "@bb/desktop-contract";
import { toDiagnosticId } from "@/lib/diagnostics";

const MAX_DECISIONS = 200;

interface DescribeReconnectInvalidationArgs {
  disconnectedAt: number;
  reconnectedAt: number;
  queryClient: QueryClient;
  queryKeys: readonly QueryKey[];
}

type ReconnectInvalidationPayload = Extract<
  DiagnosticPayload,
  { kind: "reconnect-invalidation" }
>;

export function describeReconnectInvalidation({
  disconnectedAt,
  reconnectedAt,
  queryClient,
  queryKeys,
}: DescribeReconnectInvalidationArgs): ReconnectInvalidationPayload {
  const seen = new Set<string>();
  const decisions: ReconnectInvalidationPayload["decisions"] = [];
  let invalidatedCount = 0;
  let skippedCount = 0;
  for (const queryKey of queryKeys) {
    for (const query of queryClient.getQueryCache().findAll({ queryKey })) {
      if (seen.has(query.queryHash)) {
        continue;
      }
      seen.add(query.queryHash);
      const invalidated = query.state.dataUpdatedAt < reconnectedAt;
      if (invalidated) {
        invalidatedCount += 1;
      } else {
        skippedCount += 1;
      }
      const queryName = toDiagnosticQueryName(query.queryKey[0]);
      if (decisions.length >= MAX_DECISIONS) {
        continue;
      }
      const subject = query.queryKey[1];
      decisions.push({
        dataUpdatedAt: query.state.dataUpdatedAt,
        fetching: query.state.fetchStatus === "fetching",
        invalidated,
        queryName,
        subjectId: toDiagnosticId(subject),
      });
    }
  }
  return {
    kind: "reconnect-invalidation",
    decisions,
    disconnectedAt,
    reconnectedAt,
    invalidatedCount,
    skippedCount,
  };
}
