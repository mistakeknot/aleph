export const theclaThemeCss = `
:root, .light {
  --font-sans: "Ioskeley Mono", "IoskeleyMono", monospace;
  --font-mono: "Ioskeley Mono", "IoskeleyMono", monospace;
  --font-terminal: "Ioskeley Mono", "IoskeleyMono", monospace;
  --canvas: #fcf3f7;
  --ink: #2c1723;
  --primary: #a32c6a;
  --primary-foreground: #ffffff;
  --muted-foreground: #705362;
  --subtle-foreground: #806473;
  --readback-foreground: #795c6c;
  --destructive: #b52e58;
  --destructive-foreground: #ffffff;
  --destructive-text: #ad2851;
  --warning: #91601f;
  --warning-text: #815019;
  --attention: #91601f;
  --success: #24745e;
  --diff-added: #24745e;
  --diff-removed: #ad2851;
  --pr-merged: #a32c6a;
  --file-accent: #a03d73;
}
.dark {
  --canvas: #000000;
  --ink: #f2eaf0;
  --primary: #f29bce;
  --primary-foreground: #2b1020;
  --muted-foreground: #d0adbf;
  --subtle-foreground: #b990a5;
  --readback-foreground: #c59db3;
  --destructive: #f181a4;
  --destructive-foreground: #290d1a;
  --destructive-text: #f394b2;
  --warning: #efbc8f;
  --warning-text: #efbc8f;
  --attention: #efbc8f;
  --success: #8bd5bc;
  --diff-added: #8bd5bc;
  --diff-removed: #f394b2;
  --pr-merged: #e9a3d2;
  --file-accent: #8ed5ee;
}
:root, .light {
  --thecla-wash: rgb(163 44 106 / 10%);
  --thecla-edge: linear-gradient(90deg, #a32c6a, #91376d 55%, #236e84);
}
.dark {
  --thecla-wash: rgb(242 155 206 / 12%);
  --thecla-edge: linear-gradient(90deg, #f29bce, #e9a3d2 55%, #8ed5ee);
}
.bb-sidebar-selected-row:has(> [data-sidebar-thread-id]) {
  background-image: linear-gradient(90deg, var(--thecla-wash), transparent 72%);
}
form[data-promptbox]::after {
  content: "";
  position: absolute;
  top: 0;
  left: 12px;
  right: 12px;
  height: 1px;
  background-image: var(--thecla-edge);
  opacity: .48;
  pointer-events: none;
  transition: opacity 120ms;
}
form[data-promptbox]:focus-within::after { opacity: 1; }
form[data-promptbox][data-promptbox-voice-active]::after,
form[data-promptbox]:has([aria-invalid="true"])::after { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  form[data-promptbox]::after { transition: none; }
}
@media (forced-colors: active) {
  .bb-sidebar-selected-row:has(> [data-sidebar-thread-id]) { background-image: none; }
  form[data-promptbox]::after { display: none; }
}
`;
