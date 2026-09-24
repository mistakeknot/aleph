import { isPresentationTintColor } from "../../shared/tint-color.js";
import type {
  ProviderIconColorMode,
  ProviderIconColors,
} from "../../shared/preferences.js";

interface ProviderIconTint {
  light: string;
  dark: string;
}

export function providerIconThemeVariable(providerId: string): string {
  return `--provider-icon-${providerId.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
}

function lightDark(tint: ProviderIconTint): string {
  return `light-dark(${tint.light.trim()}, ${tint.dark.trim()})`;
}

function isValidTint(tint: ProviderIconTint | null | undefined): tint is ProviderIconTint {
  return (
    tint != null &&
    isPresentationTintColor(tint.light) &&
    isPresentationTintColor(tint.dark)
  );
}

export function resolveProviderIconColor({
  providerId,
  brandTint,
  mode,
  customColors,
}: {
  providerId: string;
  brandTint: ProviderIconTint | null | undefined;
  mode: ProviderIconColorMode;
  customColors: ProviderIconColors;
}): string {
  const custom = customColors[providerId];
  if (isValidTint(custom)) return lightDark(custom);
  const fallback =
    mode === "brand" && isValidTint(brandTint)
      ? lightDark(brandTint)
      : "currentColor";
  return `var(${providerIconThemeVariable(providerId)}, var(--provider-icon, ${fallback}))`;
}
