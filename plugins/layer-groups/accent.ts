const GRADIENT_STOPS: readonly [number, readonly [number, number, number]][] = [
  [0, [0xb9, 0xa5, 0xfc]],
  [0.55, [0xe8, 0x79, 0xf9]],
  [1, [0xd9, 0xb3, 0x8c]],
];

export function accentAt(t: number): string {
  const p = Math.max(0, Math.min(1, t));
  let [aPos, aRGB] = GRADIENT_STOPS[0];
  let [bPos, bRGB] = GRADIENT_STOPS[GRADIENT_STOPS.length - 1];
  for (let i = 0; i < GRADIENT_STOPS.length - 1; i++) {
    const lo = GRADIENT_STOPS[i];
    const hi = GRADIENT_STOPS[i + 1];
    if (p >= lo[0] && p <= hi[0]) {
      [aPos, aRGB] = lo;
      [bPos, bRGB] = hi;
      break;
    }
  }
  const span = bPos - aPos || 1;
  const k = (p - aPos) / span;
  const ch = (a: number, b: number) => Math.round(a + (b - a) * k);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(ch(aRGB[0], bRGB[0]))}${hex(ch(aRGB[1], bRGB[1]))}${hex(ch(aRGB[2], bRGB[2]))}`;
}

const STACK = "ABCDEFGHIJK";

export function layerAccent(letter: string | null): string {
  if (!letter) return accentAt(1);
  const i = STACK.indexOf(letter.toUpperCase());
  if (i < 0) return accentAt(1);
  return accentAt(i / (STACK.length - 1));
}
