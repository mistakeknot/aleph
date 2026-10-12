import { useEffect } from "react";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { usesAmbientScreenCare } from "@/lib/themes";

export const AMBIENT_WAVE_PROPERTY = "--bb-ambient-wave";
export const AMBIENT_IDLE_ATTRIBUTE = "data-bb-ambient-idle";
export const AMBIENT_DRIFT_PERIOD_MS = 18 * 60_000;
export const AMBIENT_IDLE_AFTER_MS = 5 * 60_000;
export const AMBIENT_TICK_MS = 30_000;

const ACTIVITY_EVENTS = [
  "pointermove",
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
] as const;

export function ambientWave(nowMs: number): number {
  const phase = (nowMs % AMBIENT_DRIFT_PERIOD_MS) / AMBIENT_DRIFT_PERIOD_MS;
  const wave = phase < 0.5 ? phase * 2 : 2 - phase * 2;
  return Math.round(wave * 100) / 100;
}

function prefersReducedMotion(): MediaQueryList | null {
  if (typeof window.matchMedia !== "function") return null;
  return window.matchMedia("(prefers-reduced-motion: reduce)");
}

export function startAmbientScreenCare(): () => void {
  const root = document.documentElement;
  const reducedMotion = prefersReducedMotion();
  let lastActivityAt = Date.now();
  let idle = false;

  const renderWave = () => {
    if (reducedMotion?.matches) {
      root.style.removeProperty(AMBIENT_WAVE_PROPERTY);
      return;
    }
    const next = String(ambientWave(Date.now()));
    if (root.style.getPropertyValue(AMBIENT_WAVE_PROPERTY) !== next) {
      root.style.setProperty(AMBIENT_WAVE_PROPERTY, next);
    }
  };

  const setIdle = (next: boolean) => {
    if (idle === next) return;
    idle = next;
    root.toggleAttribute(AMBIENT_IDLE_ATTRIBUTE, next);
  };

  const onActivity = () => {
    lastActivityAt = Date.now();
    setIdle(false);
  };

  const tick = () => {
    renderWave();
    setIdle(Date.now() - lastActivityAt >= AMBIENT_IDLE_AFTER_MS);
  };

  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, onActivity, { passive: true, capture: true });
  }
  reducedMotion?.addEventListener("change", renderWave);
  renderWave();
  const interval = window.setInterval(tick, AMBIENT_TICK_MS);

  return () => {
    window.clearInterval(interval);
    reducedMotion?.removeEventListener("change", renderWave);
    for (const type of ACTIVITY_EVENTS) {
      window.removeEventListener(type, onActivity, { capture: true });
    }
    root.style.removeProperty(AMBIENT_WAVE_PROPERTY);
    root.removeAttribute(AMBIENT_IDLE_ATTRIBUTE);
  };
}

export function useAmbientScreenCare(): void {
  const { data } = useSystemConfig();
  const appearance = data?.appearance;
  const active = appearance ? usesAmbientScreenCare(appearance) : false;

  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    return startAmbientScreenCare();
  }, [active]);
}
