import type { MemoryAdmissionPolicy, MemoryAdmissionProvider } from "../admission.js";
import { SUPERVISED_MEMORY_POLICY } from "../ipc/memory-supervisor.js";
import { readProcessMemory } from "../ipc/rss.js";
import {
  openStore,
  type SessionSearchStore,
  type StoreTestHooks,
  type TempDirMode,
} from "../storage.js";

export const WRITER_STORE_DIR_ENV = "SESSION_SEARCH_STORE_DIR";

export function selfMemoryProvider(): MemoryAdmissionProvider | null {
  if (readProcessMemory(process.pid) === null) return null;
  const clock = (): number => Number(process.hrtime.bigint() / 1000n) / 1000;
  return {
    clock,
    sample: () => {
      const memory = readProcessMemory(process.pid);
      return memory === null
        ? null
        : { rssBytes: memory.rssBytes, sampledAtMs: clock() };
    },
    acquire: () => ({ release: () => undefined }),
  };
}

export interface WriterStoreOptions {
  testHooks?: StoreTestHooks;
  policy?: Partial<MemoryAdmissionPolicy>;
  tempDirMode?: TempDirMode;
}

export function openWriterStore(
  dir: string,
  options: WriterStoreOptions = {},
): SessionSearchStore {
  const provider = selfMemoryProvider();
  return openStore(dir, {
    ...(options.testHooks === undefined
      ? {}
      : { testHooks: options.testHooks }),
    ...(options.tempDirMode === undefined
      ? {}
      : { tempDirMode: options.tempDirMode }),
    ...(provider === null
      ? {}
      : {
          memory: {
            provider,
            policy: { ...SUPERVISED_MEMORY_POLICY, ...options.policy },
          },
        }),
  });
}
