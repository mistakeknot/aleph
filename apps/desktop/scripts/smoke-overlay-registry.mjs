// Runs the overlay plugin registry against Electron's real net.fetch and a
// local HTTP server. net.fetch returns responses with url === "", which a
// fake fetch hid before. Skipped (exit 0) when Electron cannot start headless.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let electronPath;
try {
  electronPath = require("electron");
} catch {
  console.log("SKIP: electron is not installed.");
}
if (electronPath === undefined) {
  process.exit(0);
}
const dir = await mkdtemp(join(tmpdir(), "bb-overlay-registry-smoke-"));
try {
  const registryOut = join(dir, "registry.cjs");
  await build({
    bundle: true,
    entryPoints: [join(desktopRoot, "src/overlay-registry.ts")],
    external: ["electron"],
    format: "cjs",
    logLevel: "silent",
    outfile: registryOut,
    platform: "node",
  });
  const mainOut = join(dir, "main.cjs");
  await writeFile(
    mainOut,
    `
const http = require("node:http");
const { app, net } = require("electron");
const { createServerPluginRegistry } = require(${JSON.stringify(registryOut)});
const plugin = (id) => JSON.stringify({ plugins: [{ id, enabled: true, app: { hasApp: true, bundle: { compatible: true } } }] });
const request = { pluginId: "autarch", panelId: "overlay" };
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const foreign = http.createServer((_q, r) => r.end(plugin("autarch")));
  await new Promise((ok) => foreign.listen(0, "127.0.0.1", ok));
  const foreignUrl = "http://127.0.0.1:" + foreign.address().port + "/api/v1/plugins";
  const mode = { current: "valid" };
  const server = http.createServer((q, r) => {
    if (q.url !== "/api/v1/plugins") { r.statusCode = 404; r.end(); return; }
    if (mode.current === "redirect") { r.statusCode = 302; r.setHeader("location", foreignUrl); r.end(); return; }
    if (mode.current === "oversized") { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ pad: "x".repeat(4000), plugins: [] })); return; }
    if (mode.current === "stalled") { r.setHeader("content-type", "application/json"); r.write('{"plugins":['); return; }
    r.setHeader("content-type", "application/json");
    r.end(plugin(mode.current === "other" ? "other" : "autarch"));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const origin = "http://127.0.0.1:" + server.address().port;
  const probe = await net.fetch(origin + "/api/v1/plugins");
  console.log("net.fetch response.url =", JSON.stringify(probe.url));
  await probe.text();
  const registry = createServerPluginRegistry({
    fetchImpl: (input, init) => net.fetch(input, init),
    getAppOrigin: () => origin,
    maxBytes: 1000,
    timeoutMs: 500,
  });
  const cases = [["valid", true], ["other", false], ["redirect", false], ["oversized", false], ["stalled", false]];
  let failed = false;
  for (const [name, expected] of cases) {
    mode.current = name;
    const actual = await registry.isPanelRouteAvailable(request);
    const ok = actual === expected;
    failed ||= !ok;
    console.log((ok ? "ok   " : "FAIL ") + name + " -> " + actual);
  }
  server.closeAllConnections(); server.close(); foreign.close();
  app.exit(failed ? 1 : 0);
});
`,
  );
  const child = spawn(
    electronPath,
    [
      "--no-sandbox",
      "--disable-gpu",
      "--ozone-platform=headless",
      "--user-data-dir=" + join(dir, "profile"),
      mainOut,
    ],
    { env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" }, stdio: "inherit" },
  );
  const code = await new Promise((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("exit", (c, signal) => {
      clearTimeout(timer);
      done(signal === null ? c : 124);
    });
    child.on("error", () => done(125));
  });
  if (code === 125 || code === 124) {
    console.log("SKIP: electron could not run headless (code " + code + ").");
  } else {
    process.exitCode = code ?? 1;
  }
} finally {
  await rm(dir, { force: true, recursive: true });
}
