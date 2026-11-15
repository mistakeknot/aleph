export interface CliErrorReport {
  code: string;
  details?: Record<string, unknown> | null;
  hint: string | null;
  message: string;
}

export interface CliErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    details?: Record<string, unknown>;
  };
}

export function isJsonInvocation(
  argv: readonly string[] = process.argv,
): boolean {
  const args = argv.slice(2);
  const terminator = args.indexOf("--");
  const scanned = terminator === -1 ? args : args.slice(0, terminator);
  return scanned.some(
    (arg, index) =>
      arg === "--json" ||
      arg === "--format=json" ||
      (arg === "--format" && scanned[index + 1] === "json"),
  );
}

export function toCliErrorEnvelope(report: CliErrorReport): CliErrorEnvelope {
  return {
    ok: false,
    error: {
      code: report.code,
      message: report.message,
      ...(report.hint === null ? {} : { hint: report.hint }),
      ...(report.details === undefined || report.details === null
        ? {}
        : { details: report.details }),
    },
  };
}

let jsonPayloadWritten = false;

export function beginJsonOutputTracking(): void {
  jsonPayloadWritten = false;
}

export function noteJsonPayloadWritten(): void {
  jsonPayloadWritten = true;
}

export function writeCliErrorEnvelope(
  report: CliErrorReport,
  json: boolean,
): void {
  if (!json || jsonPayloadWritten) return;
  console.log(JSON.stringify(toCliErrorEnvelope(report), null, 2));
}
