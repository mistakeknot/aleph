import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(SCRIPT_DIR, "icon-source");
const ASSETS_DIR = path.join(SCRIPT_DIR, "..", "assets");
const TOOLS_DIR = path.join(SCRIPT_DIR, ".icon-tools");

function installToolsOneOff() {
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TOOLS_DIR, "package.json"), JSON.stringify({ name: "icon-tools", private: true }));
  execFileSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", "sharp", "@resvg/resvg-wasm"], {
    cwd: TOOLS_DIR,
    stdio: "inherit",
  });
}

function requireToolsFrom(anchorUrl) {
  const req = createRequire(anchorUrl);
  return { sharp: req("sharp"), resvg: req("@resvg/resvg-wasm"), require: req };
}

function loadTools() {
  try {
    return requireToolsFrom(import.meta.url);
  } catch {}
  const anchor = pathToFileURL(path.join(TOOLS_DIR, "noop.cjs")).href;
  try {
    return requireToolsFrom(anchor);
  } catch {
    installToolsOneOff();
    return requireToolsFrom(anchor);
  }
}

let wasmReady = false;

async function renderMaster(tools, svgPath) {
  const { Resvg, initWasm } = tools.resvg;
  if (!wasmReady) {
    const wasmPath = tools.require.resolve("@resvg/resvg-wasm/index_bg.wasm");
    await initWasm(fs.readFileSync(wasmPath));
    wasmReady = true;
  }
  const png = new Resvg(fs.readFileSync(svgPath, "utf8"), { fitTo: { mode: "width", value: 2048 } }).render().asPng();
  return Buffer.from(png);
}

async function downscale(sharp, sourcePng, size) {
  return sharp(sourcePng).resize(size, size, { kernel: "lanczos3" }).png().toBuffer();
}

function icnsChunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(8 + data.length, 4);
  return Buffer.concat([header, data]);
}

function buildIcns(slots) {
  const body = Buffer.concat(slots.map(({ type, png }) => icnsChunk(type, png)));
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

const ICNS_SLOTS = [
  { type: "icp4", size: 16, source: "small", label: "16" },
  { type: "ic11", size: 32, source: "master", label: "16@2x" },
  { type: "icp5", size: 32, source: "small", label: "32" },
  { type: "ic12", size: 64, source: "master", label: "32@2x" },
  { type: "ic07", size: 128, source: "master", label: "128" },
  { type: "ic13", size: 256, source: "master", label: "128@2x" },
  { type: "ic08", size: 256, source: "master", label: "256" },
  { type: "ic14", size: 512, source: "master", label: "256@2x" },
  { type: "ic09", size: 512, source: "master", label: "512" },
  { type: "ic10", size: 1024, source: "master", label: "512@2x" },
];

async function main() {
  const tools = loadTools();
  const { sharp } = tools;
  const master = await renderMaster(tools, path.join(SOURCE_DIR, "icon.svg"));
  const small = await renderMaster(tools, path.join(SOURCE_DIR, "icon-small.svg"));

  const slotPngs = [];
  for (const slot of ICNS_SLOTS) {
    const src = slot.source === "small" ? small : master;
    const png = await downscale(sharp, src, slot.size);
    slotPngs.push({ type: slot.type, png });
  }

  fs.writeFileSync(path.join(ASSETS_DIR, "icon.icns"), buildIcns(slotPngs));

  const currentIconPng = await sharp(path.join(ASSETS_DIR, "icon.png")).metadata();
  const targetSize = currentIconPng.width ?? 1024;
  const iconPng = await downscale(sharp, master, targetSize);
  fs.writeFileSync(path.join(ASSETS_DIR, "icon.png"), iconPng);

  console.log(`Wrote ${path.join(ASSETS_DIR, "icon.icns")} (${ICNS_SLOTS.length} slots) and icon.png (${targetSize}x${targetSize}).`);
}

main();
