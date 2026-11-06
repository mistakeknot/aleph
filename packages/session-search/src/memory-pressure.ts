export const MEMORY_PRESSURE_META_KEY = "memory_pressure";
export const RECENT_FAILURE_LIMIT = 8;

export interface FailureObservation {
  sourceKey: string;
  generation: number;
  mergePossible: boolean;
  atMs: number;
}

export type MemoryPressureStatus = "clear" | "suspended" | "retry_armed";

export interface MemoryPressureState {
  status: MemoryPressureStatus;
  consecutiveFailures: number;
  totalFailures: number;
  clears: number;
  retriesUsed: number;
  lastFailureMs: number | null;
  mitigation: string | null;
  recent: FailureObservation[];
}

export function initialMemoryPressureState(): MemoryPressureState {
  return {
    status: "clear",
    consecutiveFailures: 0,
    totalFailures: 0,
    clears: 0,
    retriesUsed: 0,
    lastFailureMs: null,
    mitigation: null,
    recent: [],
  };
}

export function parseMemoryPressureState(
  raw: string | undefined,
): MemoryPressureState {
  if (raw === undefined) return initialMemoryPressureState();
  const parsed = JSON.parse(raw) as Partial<MemoryPressureState>;
  const base = initialMemoryPressureState();
  const status = parsed.status;
  if (
    status !== "clear" &&
    status !== "suspended" &&
    status !== "retry_armed"
  ) {
    throw new Error("stored memory pressure state has an unknown status");
  }
  return {
    ...base,
    ...parsed,
    status,
    recent: Array.isArray(parsed.recent)
      ? parsed.recent.slice(-RECENT_FAILURE_LIMIT)
      : [],
  };
}

export interface AttributionEvidence {
  failures: readonly FailureObservation[];
  interveningSuccessesFromOtherSources: number;
}

export interface Attribution {
  scope: "store" | "source";
  reason: string;
}

export function attributeMemoryFailure(
  evidence: AttributionEvidence,
): Attribution {
  const { failures, interveningSuccessesFromOtherSources } = evidence;
  if (failures.length === 0) {
    return {
      scope: "store",
      reason: "no failure evidence; charged to the store",
    };
  }
  if (failures.some((failure) => failure.mergePossible)) {
    return {
      scope: "store",
      reason:
        "an FTS merge could have run in a failed batch; charged to the store",
    };
  }
  if (failures.length < 2) {
    return {
      scope: "store",
      reason: "a single failure cannot rule out shared memory pressure",
    };
  }
  if (interveningSuccessesFromOtherSources < 1) {
    return {
      scope: "store",
      reason:
        "no other source committed between the failures; shared pressure is not ruled out",
    };
  }
  return {
    scope: "source",
    reason:
      "repeated same-generation failures with no merge window and other sources committing in between",
  };
}

export function sameGenerationFailures(
  recent: readonly FailureObservation[],
  sourceKey: string,
  generation: number,
): FailureObservation[] {
  return recent.filter(
    (failure) =>
      failure.sourceKey === sourceKey && failure.generation === generation,
  );
}
