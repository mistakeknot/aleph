import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FramedChild } from "../../src/ipc/framed-child.js";

const here = dirname(fileURLToPath(import.meta.url));
const childScript = join(here, "frame-child.ts");
const packageDir = join(here, "..", "..");

const mode = process.argv[2] ?? "";
const advertised = Number(process.argv[3] ?? "0");

let peakRss = process.memoryUsage.rss();
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
}, 1);

function childArgs(...rest: string[]): string[] {
  return ["--import", "tsx", childScript, ...rest];
}

async function warmUp(): Promise<void> {
  const frames: Buffer[] = [];
  const child = new FramedChild({
    args: childArgs("echo"),
    cwd: packageDir,
    onFrame: (payload) => frames.push(payload),
  });
  await child.sendJson({ warm: "up" });
  while (frames.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await child.close(1000);
}

async function guarded(): Promise<Record<string, unknown>> {
  const child = new FramedChild({
    args: childArgs("advertise-joined", String(advertised)),
    cwd: packageDir,
    onFrame: () => {},
  });
  const exit = await child.exited;
  const stats = child.stats();
  return {
    cause: exit.cause,
    reason: exit.violation?.reason ?? null,
    reapLatencyMs: exit.reapLatencyMs,
    peakBufferedBytes: stats.peakBufferedBytes,
    largestChunkBytes: stats.largestChunkBytes,
    bytesReceived: stats.bytesReceived,
  };
}

async function naive(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let held = 0;
  const child = spawn(
    process.execPath,
    childArgs("advertise", String(advertised)),
    {
      cwd: packageDir,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    },
  );
  const output = child.stdio[4];
  output?.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    held += chunk.byteLength;
    if (held >= advertised + 4) child.kill("SIGKILL");
  });
  await new Promise((resolve) => child.once("close", resolve));
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
  return {
    cause: "naive",
    reason: null,
    reapLatencyMs: null,
    peakBufferedBytes: held,
    largestChunkBytes: chunks.reduce((m, c) => Math.max(m, c.byteLength), 0),
    bytesReceived: held,
  };
}

async function main(): Promise<void> {
  await warmUp();
  global.gc?.();
  const baselineRss = process.memoryUsage.rss();
  peakRss = baselineRss;
  const result = mode === "naive" ? await naive() : await guarded();
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
  clearInterval(sampler);
  process.stdout.write(
    `${JSON.stringify({
      mode,
      advertised,
      baselineRss,
      peakRss,
      rssIncreaseBytes: Math.max(0, peakRss - baselineRss),
      ...result,
    })}\n`,
  );
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  },
);
