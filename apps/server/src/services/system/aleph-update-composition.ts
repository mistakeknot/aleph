import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerLogger } from "../../types.js";
import {
  DEFAULT_ALEPH_UPDATE_PATHS,
  type AlephDirectStartPolicy,
  type AlephInstallRequestStore,
  createAlephUpdateService,
  type AlephUpdateAuditRecord,
  type AlephUpdateService,
} from "./aleph-update.js";

export type AlephUpdateNoticeSink = (message: string) => Promise<void>;

export const noopAlephUpdateNotice: AlephUpdateNoticeSink = async () => {};

type AlephUpdateServiceArgs = Parameters<typeof createAlephUpdateService>[0];

export interface CreateServerAlephUpdateServiceArgs {
  appVersion: string;
  countRunningThreads: () => number;
  dataDir: string;
  directStart?: AlephDirectStartPolicy;
  logger: ServerLogger;
  notify?: AlephUpdateNoticeSink;
  requests?: AlephInstallRequestStore;
  overrides?: Partial<AlephUpdateServiceArgs>;
}

export function createAlephUpdateAuditSink(args: {
  dir: string;
  now?: () => number;
}): (record: AlephUpdateAuditRecord) => void {
  const now = args.now ?? Date.now;
  const file = join(args.dir, "audit.jsonl");
  return (record) => {
    mkdirSync(args.dir, { recursive: true });
    appendFileSync(
      file,
      `${JSON.stringify({ at: new Date(now()).toISOString(), ...record })}\n`,
    );
  };
}

export function createServerAlephUpdateService(
  args: CreateServerAlephUpdateServiceArgs,
): AlephUpdateService {
  const floorStateDir = join(args.dataDir, "aleph-update");
  return createAlephUpdateService({
    appVersion: args.appVersion,
    audit: createAlephUpdateAuditSink({ dir: floorStateDir }),
    countRunningThreads: args.countRunningThreads,
    ...(args.directStart === undefined
      ? {}
      : { directStart: args.directStart }),
    logger: args.logger,
    notify: args.notify ?? noopAlephUpdateNotice,
    paths: { ...DEFAULT_ALEPH_UPDATE_PATHS, floorStateDir },
    ...(args.requests === undefined ? {} : { requests: args.requests }),
    ...args.overrides,
  });
}
