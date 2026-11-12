import {
  alephOverviewExportSchema,
  type AlephOverview,
} from "@bb/server-contract";

export async function readAlephOverview(args: {
  runningVersion: string;
  read: () => Promise<string | null>;
  now: number;
  previous?: AlephOverview;
}): Promise<AlephOverview> {
  let input: unknown = null;
  try {
    const text = await args.read();
    input = text === null ? null : JSON.parse(text);
  } catch {}
  const parsed = alephOverviewExportSchema.safeParse(input);
  const data = parsed.success ? parsed.data : args.previous;
  const recent = (stamp: string, age: number) => {
    const elapsed = args.now - Date.parse(stamp);
    return elapsed >= 0 && elapsed <= age;
  };
  return {
    installation: data?.installation ?? null,
    qualification: data?.qualification ?? null,
    upstream: data?.upstream ?? null,
    summary: data?.summary ?? null,
    sync:
      data?.sync && recent(data.sync.heartbeatAt, 15 * 60_000)
        ? data.sync
        : null,
    runningVersion: args.runningVersion,
    stale:
      !parsed.success ||
      [data?.qualification, data?.upstream, data?.installation].some(
        (source) =>
          source != null && !recent(source.checkedAt, 24 * 60 * 60_000),
      ),
    requestRecipientConfigured: false,
    requestDelivery: "unavailable",
  };
}
