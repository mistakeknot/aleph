import { RENDER_OPACITY_FRACTIONS } from "@/lib/music/dorcas-colors";
import {
  MOTION_DEAD_BAND,
  MOTION_EXTREME_TOLERANCE,
} from "@/lib/music/motion-governor";
import {
  readShippedDorcasModes,
  strictRule,
  WCAG_FLASH_RULE,
} from "./flash-checker";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SHIPPED_DORCAS_MODES = readShippedDorcasModes();
export const MAX_REVERSALS_PER_SECOND = 4;
export const WCAG_MAX_REVERSALS_PER_SECOND = 4;
export const PIPELINE_TOLERANCE = 1e-5;

export const STRICT_FLASH_RULE = strictRule(
  RENDER_OPACITY_FRACTIONS,
  MOTION_DEAD_BAND + PIPELINE_TOLERANCE,
  MOTION_EXTREME_TOLERANCE,
);

export const FLASH_RULES = [
  {
    name: "governor grid",
    rule: STRICT_FLASH_RULE,
    max: MAX_REVERSALS_PER_SECOND,
  },
  {
    name: "WCAG off grid",
    rule: WCAG_FLASH_RULE,
    max: WCAG_MAX_REVERSALS_PER_SECOND,
  },
] as const;
