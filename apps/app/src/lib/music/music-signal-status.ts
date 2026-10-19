import { useSyncExternalStore } from "react";
import type { MusicSignalStatus } from "./music-signal-controller";

let current: MusicSignalStatus = { kind: "off" };
const listeners = new Set<() => void>();

export function setMusicSignalStatus(status: MusicSignalStatus): void {
  current = status;
  for (const listener of listeners) listener();
}

export function getMusicSignalStatus(): MusicSignalStatus {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMusicSignalStatus(): MusicSignalStatus {
  return useSyncExternalStore(subscribe, getMusicSignalStatus);
}
