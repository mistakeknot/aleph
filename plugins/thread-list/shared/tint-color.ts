const PRESENTATION_TINT_COLOR_PATTERN =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([-+.%\w\s,/]*\)|[a-z]{3,20})$/iu;

export function isPresentationTintColor(value: string): boolean {
  return PRESENTATION_TINT_COLOR_PATTERN.test(value.trim());
}
