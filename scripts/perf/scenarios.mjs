import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const probeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "probe.js"),
  "utf8",
);

const MOD_CTRL = 2;

function record(recorder, name, result, context) {
  const reason = result?.timedOut === true ? "timed out" : "no value";
  recorder.add(name, result?.ms ?? null, context === undefined ? reason : `${reason}: ${context}`);
}

function keyCode(char) {
  if (/^[a-z]$/u.test(char)) return `Key${char.toUpperCase()}`;
  if (char === " ") return "Space";
  return "";
}

export class Driver {
  constructor(session, baseUrl) {
    this.session = session;
    this.baseUrl = baseUrl;
  }

  eval(expression) {
    return this.session.evaluate(expression);
  }

  probe(expression) {
    return this.eval(`window.__perf.${expression}`);
  }

  async arm(name, predicate, options) {
    await this.probe(
      `arm(${JSON.stringify(name)}, ${JSON.stringify(predicate)}, ${JSON.stringify(options)})`,
    );
  }

  async result(name) {
    return this.probe(`result(${JSON.stringify(name)})`);
  }

  async char(char) {
    const code = keyCode(char);
    await this.session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: char,
      text: char,
      code,
      windowsVirtualKeyCode: char.toUpperCase().charCodeAt(0),
    });
    await this.session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: char,
      code,
      windowsVirtualKeyCode: char.toUpperCase().charCodeAt(0),
    });
  }

  async special(key, code, virtualKey, modifiers = 0) {
    await this.session.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: virtualKey,
      modifiers,
    });
    await this.session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: virtualKey,
      modifiers,
    });
  }

  async chordCtrlK() {
    await this.session.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
      modifiers: MOD_CTRL,
    });
    await this.session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "k",
      code: "KeyK",
      windowsVirtualKeyCode: 75,
      modifiers: MOD_CTRL,
      text: "",
    });
    await this.session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "k",
      code: "KeyK",
      windowsVirtualKeyCode: 75,
      modifiers: MOD_CTRL,
    });
    await this.session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
    });
  }

  enter() {
    return this.special("Enter", "Enter", 13);
  }

  escape() {
    return this.special("Escape", "Escape", 27);
  }

  arrowDown() {
    return this.special("ArrowDown", "ArrowDown", 40);
  }

  async click(x, y) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.session.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
    }
  }

  async quiesce({ stableMs = 1000, maxMs = 12000 } = {}) {
    const deadline = Date.now() + maxMs;
    let last = -1;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const count = await this.probe("resourceCount()");
      if (count !== last) {
        last = count;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableMs) return true;
      await delay(150);
    }
    return false;
  }

  async warmBrowser() {
    const loaded = new Promise((resolve) =>
      this.session.on("Page.loadEventFired", resolve),
    );
    await this.session.send("Page.navigate", {
      url: `${this.baseUrl}/api/v1/system/version`,
    });
    await loaded;
    await this.session.send("Network.enable");
    await this.session.send("Network.clearBrowserCache");
  }

  async loadApp() {
    await this.session.send("Page.navigate", { url: `${this.baseUrl}/` });
    await this.waitTrue(`h.sidebarRows() > 0`, 30000);
    await this.quiesce({ stableMs: 1000, maxMs: 8000 });
  }

  async goHome() {
    await this.probe(`pushPath("/")`);
    await this.waitTrue(`h.threadId() === null && h.sidebarRows() > 0`);
    await this.quiesce({ stableMs: 600, maxMs: 6000 });
  }

  async waitTrue(predicate, timeoutMs = 15000) {
    const name = `wait-${Math.random()}`;
    await this.arm(name, `(h) => ${predicate}`, {
      startOn: "now",
      timeoutMs,
    });
    return this.result(name);
  }
}

export async function installProbe(session) {
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: probeSource,
  });
}

export async function startupScenario(driver, recorder, { navigate }) {
  const label = navigate === "cold" ? "startup" : "startup_warm";
  await driver.session.send("Page.navigate", { url: `${driver.baseUrl}/` });
  const measure = async (name, predicate) => {
    await driver.arm(name, predicate, { startOn: "origin", timeoutMs: 30000 });
  };
  await measure("shell", `(h) => document.querySelector("[data-testid=app-layout-root]") !== null`);
  await measure("rows", `(h) => h.sidebarRows() > 0`);
  await measure("composer", `(h) => document.querySelector(".ProseMirror") !== null`);
  for (const [name, metric] of [
    ["shell", "shell_ms"],
    ["rows", "sidebar_rows_ms"],
    ["composer", "composer_ms"],
  ]) {
    record(recorder, `${label}.${metric}`, await driver.result(name));
  }
  const startup = await driver.probe("startup()");
  recorder.add(`${label}.fcp_ms`, startup.fcp, "no first-contentful-paint entry");
  await driver.quiesce();
  const settled = await driver.probe("startup()");
  recorder.add(`${label}.load_event_ms`, settled.load, "no load event entry");
  recorder.add(`${label}.requests`, settled.requests);
  recorder.add(`${label}.transfer_kb`, settled.transferKb);
  const bootstrap = await driver.probe(`resource("/api/v1/sidebar-bootstrap")`);
  recorder.add(
    `${label}.sidebar_bootstrap_ms`,
    bootstrap?.duration ?? null,
    "no sidebar-bootstrap resource entry",
  );
}

async function openPalette(driver, metric, recorder) {
  await driver.arm(
    "open",
    `(h) => h.optionCount() > 0 && !/Loading threads/u.test(h.paletteText())`,
    { startOn: "keydown", key: "k", timeoutMs: 10000 },
  );
  await driver.chordCtrlK();
  const value = await driver.result("open");
  if (metric !== null) record(recorder, metric, value);
  return value.ms;
}

async function closePalette(driver) {
  await driver.escape();
  await driver.waitTrue(`document.querySelector("[data-testid=command-palette]") === null`, 3000);
}

export async function cmdkScenario(driver, recorder, { queries, reps }) {
  await openPalette(driver, "cmdk.open_first_ms", recorder);
  await closePalette(driver);
  await delay(300);
  for (let index = 0; index < reps; index += 1) {
    await openPalette(driver, "cmdk.open_warm_ms", recorder);
    await closePalette(driver);
    await delay(200);
  }
  for (let index = 0; index < reps; index += 1) {
    const query = queries[index % queries.length];
    await openPalette(driver, null, recorder);
    const head = query.slice(0, -1);
    for (const char of head) {
      await driver.char(char);
      await delay(45);
    }
    await delay(600);
    const quote = JSON.stringify(query);
    await driver.arm(
      "rows",
      `(h) => h.paletteInput() === ${quote} && h.optionCount() > 0 && !/Searching threads|Type at least/u.test(h.paletteText())`,
      { startOn: "keydown", timeoutMs: 10000 },
    );
    await driver.arm(
      "result",
      `(h) => h.paletteInput() === ${quote} && h.searchDone(${quote}) && h.optionCount() > 0 && !/Searching threads|Type at least/u.test(h.paletteText())`,
      { startOn: "keydown", timeoutMs: 10000 },
    );
    await driver.char(query.at(-1));
    const rows = await driver.result("rows");
    const result = await driver.result("result");
    record(recorder, "cmdk.keystroke_first_rows_ms", rows);
    record(recorder, "cmdk.keystroke_result_ms", result);
    await closePalette(driver);
    await delay(300);
  }
}

export async function switchScenario(driver, recorder, { reps }) {
  await driver.goHome();
  for (let index = 0; index < reps; index += 1) {
    await driver.goHome();
    const target = await driver.probe(
      `rect("a[data-sidebar-thread-id]", ${index + 1})`,
    );
    if (target === null) {
      recorder.add(
        "switch.sidebar_click_ms",
        null,
        `no sidebar thread row at index ${index + 1}`,
      );
      continue;
    }
    await driver.arm("switch", `(h) => h.threadVisible(null)`, {
      startOn: "click",
      timeoutMs: 15000,
    });
    await driver.click(target.x, target.y);
    const value = await driver.result("switch");
    record(recorder, "switch.sidebar_click_ms", value);
    await delay(400);
  }
  for (let index = 0; index < reps; index += 1) {
    await driver.goHome();
    await openPalette(driver, null, recorder);
    for (let step = 0; step < index + 6; step += 1) {
      await driver.arrowDown();
      await delay(30);
    }
    let selected = await driver.probe("helpers.selectedOptionText()");
    for (let skip = 0; skip < 3 && /^Show more/u.test(selected ?? ""); skip += 1) {
      await driver.arrowDown();
      await delay(30);
      selected = await driver.probe("helpers.selectedOptionText()");
    }
    await driver.arm("navigate", `(h) => location.pathname !== "/"`, {
      startOn: "keydown",
      key: "Enter",
      timeoutMs: 15000,
    });
    await driver.arm("switch", `(h) => h.threadVisible(null)`, {
      startOn: "keydown",
      key: "Enter",
      timeoutMs: 15000,
    });
    await driver.enter();
    const navigated = await driver.result("navigate");
    const value = await driver.result("switch");
    const context = `Enter after ${index + 6}+ ArrowDown on ${JSON.stringify(selected)}`;
    record(recorder, "switch.cmdk_enter_navigate_ms", navigated, context);
    record(recorder, "switch.cmdk_enter_ms", value, context);
    await delay(400);
  }
}

async function openThread(driver, threadId) {
  await driver.arm("open-thread", `(h) => h.threadVisible(null) && h.threadId() === ${JSON.stringify(threadId)}`, {
    startOn: "now",
    timeoutMs: 30000,
  });
  await driver.probe(`pushPath(${JSON.stringify(`/threads/${threadId}`)})`);
  return driver.result("open-thread");
}

export async function threadOpenScenario(driver, recorder, { meta, reps }) {
  await driver.goHome();
  for (const thread of meta.small.slice(0, reps)) {
    record(recorder, "thread_open.small_ms", await openThread(driver, thread.id));
    await delay(300);
    await driver.goHome();
  }
  for (const thread of meta.medium) {
    record(recorder, "thread_open.medium_ms", await openThread(driver, thread.id));
    await delay(300);
    await driver.goHome();
  }
  record(recorder, "thread_open.large_ms", await openThread(driver, meta.large.id));
  await driver.quiesce({ stableMs: 1200, maxMs: 10000 });
  await driver.goHome();
  for (let index = 0; index < 2; index += 1) {
    record(
      recorder,
      "thread_open.large_revisit_ms",
      await openThread(driver, meta.large.id),
    );
    await driver.quiesce({ stableMs: 800, maxMs: 6000 });
    await driver.goHome();
  }
}

async function typeInComposer(driver, recorder, metric, { count = 40 }) {
  await driver.eval(`document.querySelector(".ProseMirror")?.focus(), true`);
  await driver.probe(`startTyping(".ProseMirror")`);
  const text = "the quick brown fox jumps over a lazy dog again";
  const typed = text.slice(0, count);
  for (const char of typed) {
    await driver.char(char);
    await delay(60);
  }
  await delay(400);
  const { latencies } = await driver.probe("stopTyping()");
  for (const value of latencies) recorder.add(metric, value);
  recorder.missing(
    metric,
    typed.length - latencies.length,
    "keystroke never reflected in the editor",
  );
  await driver.eval(`(() => { const e = document.querySelector(".ProseMirror"); if (e) { e.focus(); document.execCommand("selectAll"); document.execCommand("delete"); } return true; })()`);
}

export async function composerScenario(driver, recorder, { meta }) {
  await driver.goHome();
  await driver.waitTrue(`document.querySelector(".ProseMirror") !== null`);
  await typeInComposer(driver, recorder, "composer.type_home_ms", {});
  await openThread(driver, meta.large.id);
  await driver.quiesce({ stableMs: 1200, maxMs: 10000 });
  await driver.waitTrue(`document.querySelector(".ProseMirror") !== null`);
  await typeInComposer(driver, recorder, "composer.type_large_thread_ms", {});
}

async function fetchWithReset(url) {
  try {
    return await fetch(url);
  } catch (error) {
    if (error?.cause?.code !== "ECONNRESET") throw error;
    return fetch(url);
  }
}

export async function serverScenario(baseUrl, meta, recorder, { reps = 30, warmups = 3 } = {}) {
  const small = meta.small[0].id;
  const large = meta.large.id;
  const routes = {
    "sidebar-bootstrap": "/api/v1/sidebar-bootstrap",
    "thread-detail-small": `/api/v1/threads/${small}?include=environment,host`,
    "thread-detail-large": `/api/v1/threads/${large}?include=environment,host`,
    "timeline-small": `/api/v1/threads/${small}/timeline`,
    "timeline-large": `/api/v1/threads/${large}/timeline`,
    "outline-large": `/api/v1/threads/${large}/conversation-outline`,
    "thread-list-project": `/api/v1/threads?projectId=${meta.large.projectId}&archived=false`,
  };
  meta.queries.slice(0, 3).forEach((query, index) => {
    routes[`search-${index + 1}`] =
      `/api/v1/threads/search?limitPerGroup=20&query=${encodeURIComponent(query)}`;
  });
  for (const [name, path] of Object.entries(routes)) {
    for (let index = 0; index < warmups + reps; index += 1) {
      const started = performance.now();
      const response = await fetchWithReset(`${baseUrl}${path}`);
      await response.arrayBuffer();
      const elapsed = performance.now() - started;
      if (!response.ok) {
        throw new Error(`${path} responded ${response.status}`);
      }
      if (index >= warmups) recorder.add(`server.${name}_ms`, elapsed);
    }
  }
}
