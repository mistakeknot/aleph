export const dorcasThemeCss = `
@font-face {
  font-family: "Ioskeley Mono";
  src:
    local("Ioskeley Mono"),
    local("IoskeleyMono"),
    url("/api/v1/system/fonts/ioskeley-mono.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
:root, .light {
  --font-sans: "Ioskeley Mono", Iosevka, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --font-mono: "Ioskeley Mono", Iosevka, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --font-terminal: "Ioskeley Mono", Iosevka, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --canvas: #ede4e8;
  --ink: #3a2631;
  --primary: #94406d;
  --primary-foreground: #ffffff;
  --muted-foreground: #6e5664;
  --subtle-foreground: #7c6371;
  --readback-foreground: #775e6c;
  --destructive: #a63d5e;
  --destructive-foreground: #ffffff;
  --destructive-text: #9e3656;
  --warning: #85602c;
  --warning-text: #7a5524;
  --attention: #85602c;
  --success: #2f6f5c;
  --diff-added: #2f6f5c;
  --diff-removed: #9e3656;
  --pr-merged: #94406d;
  --file-accent: #2f6b80;
}
.dark {
  --canvas: #000000;
  --ink: #cfc5cc;
  --primary: #c97fa9;
  --primary-foreground: #1f0b17;
  --muted-foreground: #a98e9c;
  --subtle-foreground: #917684;
  --readback-foreground: #9c8190;
  --destructive: #c96a88;
  --destructive-foreground: #1f0912;
  --destructive-text: #cf7a95;
  --warning: #c49a74;
  --warning-text: #c49a74;
  --attention: #c49a74;
  --success: #72ad99;
  --diff-added: #72ad99;
  --diff-removed: #cf7a95;
  --pr-merged: #bf86ad;
  --file-accent: #74aec2;
}
html {
  --dorcas-hue: calc(350 - 125 * var(--bb-ambient-wave, 0));
  --dorcas-line: oklch(0.55 0.08 var(--dorcas-hue));
  --dorcas-wash: oklch(0.55 0.08 var(--dorcas-hue) / 10%);
}
html.dark {
  --dorcas-line: oklch(0.36 0.06 var(--dorcas-hue));
  --dorcas-wash: oklch(0.5 0.08 var(--dorcas-hue) / 12%);
  --border: var(--dorcas-line);
  --border-hairline: var(--dorcas-line);
  --border-seam: oklch(0.22 0.035 var(--dorcas-hue));
  --sidebar-border: var(--border-seam);
  --input: oklch(0.42 0.065 var(--dorcas-hue));
}
.bb-sidebar-selected-row:has(> [data-sidebar-thread-id]) {
  background-image: linear-gradient(90deg, var(--dorcas-wash), transparent 72%);
}
form[data-promptbox]::after {
  content: "";
  position: absolute;
  top: 0;
  left: 12px;
  right: 12px;
  height: 1px;
  background-color: var(--dorcas-line);
  opacity: .6;
  pointer-events: none;
  transition: opacity 120ms;
}
form[data-promptbox]:focus-within::after { opacity: 1; }
form[data-promptbox][data-promptbox-voice-active]::after,
form[data-promptbox]:has([aria-invalid="true"])::after { opacity: 0; }
html[data-bb-ambient-idle]::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  background-color: rgb(0 0 0 / 65%);
  pointer-events: none;
  animation: dorcas-dusk 4s ease-out;
}
@keyframes dorcas-dusk {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  form[data-promptbox]::after { transition: none; }
  html[data-bb-ambient-idle]::after { animation: none; }
}
@media (forced-colors: active) {
  .bb-sidebar-selected-row:has(> [data-sidebar-thread-id]) { background-image: none; }
  form[data-promptbox]::after { display: none; }
  html[data-bb-ambient-idle]::after { display: none; }
}
`;
