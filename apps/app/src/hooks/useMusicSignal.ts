import { useEffect, useRef } from "react";
import {
  MUSIC_MODE_THEME_ID,
  musicPairingSchema,
  type AppTheme,
} from "@bb/domain";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  AMBIENT_IDLE_ATTRIBUTE,
  AMBIENT_REST_ATTRIBUTE,
} from "@/hooks/useAmbientScreenCare";
import {
  browserMusicSocket,
  decodeMusicSecret,
  MusicSignalController,
  type MusicEnvironment,
  type MusicPairingBytes,
} from "@/lib/music/music-signal-controller";
import { setMusicSignalStatus } from "@/lib/music/music-signal-status";
import { webCryptoHmac, webCryptoRandom } from "@/lib/music/webcrypto-hmac";
import { sdk } from "@/lib/sdk";

export const MUSIC_SUPPRESS_QUERIES = [
  "(prefers-reduced-motion: reduce)",
  "(forced-colors: active)",
] as const;

export function musicSignalEnabled(appearance: AppTheme): boolean {
  return (
    appearance.musicMode &&
    appearance.themeId === MUSIC_MODE_THEME_ID &&
    appearance.musicSecret === "set"
  );
}

export function musicSignalRevision(appearance: AppTheme): string {
  return `${appearance.musicPort}:${appearance.musicSecret ?? "unset"}`;
}

export function observeMusicEnvironment(
  win: Window,
  root: HTMLElement,
  onChange: (environment: MusicEnvironment) => void,
): () => void {
  const queries =
    typeof win.matchMedia === "function"
      ? MUSIC_SUPPRESS_QUERIES.map((query) => win.matchMedia(query))
      : [];
  const read = (): MusicEnvironment => ({
    visible: win.document.visibilityState === "visible",
    suppressed: queries.some((query) => query.matches),
    rest:
      root.hasAttribute(AMBIENT_REST_ATTRIBUTE) ||
      root.hasAttribute(AMBIENT_IDLE_ATTRIBUTE),
  });
  let last = read();
  const update = () => {
    const next = read();
    if (
      next.visible === last.visible &&
      next.suppressed === last.suppressed &&
      next.rest === last.rest
    ) {
      return;
    }
    last = next;
    onChange(next);
  };
  const observer = new MutationObserver(update);
  observer.observe(root, {
    attributes: true,
    attributeFilter: [AMBIENT_REST_ATTRIBUTE, AMBIENT_IDLE_ATTRIBUTE],
  });
  win.document.addEventListener("visibilitychange", update);
  for (const query of queries) query.addEventListener("change", update);
  onChange(last);
  return () => {
    observer.disconnect();
    win.document.removeEventListener("visibilitychange", update);
    for (const query of queries) query.removeEventListener("change", update);
  };
}

async function loadMusicPairing(): Promise<MusicPairingBytes | null> {
  const parsed = musicPairingSchema.safeParse(await sdk.theme.musicPairing());
  if (!parsed.success || parsed.data.secret === null) return null;
  const secret = decodeMusicSecret(parsed.data.secret);
  return secret === null ? null : { port: parsed.data.port, secret };
}

export function createBrowserMusicSignal(): MusicSignalController {
  return new MusicSignalController({
    root: document.documentElement,
    origin: window.location.origin,
    connect: browserMusicSocket,
    loadPairing: loadMusicPairing,
    hmac: webCryptoHmac,
    random: webCryptoRandom,
    now: () => performance.now(),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (id) => window.clearTimeout(id),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    onStatus: setMusicSignalStatus,
  });
}

export function useMusicSignal(): void {
  const { data } = useSystemConfig();
  const appearance = data?.appearance;
  const enabled = appearance ? musicSignalEnabled(appearance) : false;
  const revision = appearance ? musicSignalRevision(appearance) : "";
  const running = useRef<{
    controller: MusicSignalController;
    stopObserving: () => void;
  } | null>(null);

  useEffect(() => {
    if (
      !enabled ||
      running.current !== null ||
      typeof document === "undefined" ||
      typeof WebSocket === "undefined"
    ) {
      return;
    }
    const controller = createBrowserMusicSignal();
    const stopObserving = observeMusicEnvironment(
      window,
      document.documentElement,
      (environment) => controller.setEnvironment(environment),
    );
    running.current = { controller, stopObserving };
  }, [enabled]);

  useEffect(() => {
    running.current?.controller.setEnabled(enabled, revision);
  }, [enabled, revision]);

  useEffect(
    () => () => {
      running.current?.stopObserving();
      running.current?.controller.dispose();
      running.current = null;
    },
    [],
  );
}
