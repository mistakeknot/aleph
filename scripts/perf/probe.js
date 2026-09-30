(() => {
  if (window.__perf !== undefined) return;
  const state = {
    armed: new Map(),
    keydowns: [],
    clicks: [],
    fetches: [],
    typing: null,
  };
  const now = () => performance.now();

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    const startedAt = now();
    const promise = originalFetch(input, init);
    if (url.includes("/api/v1/threads/search")) {
      const entry = { url, startedAt, headersAt: null, doneAt: null };
      state.fetches.push(entry);
      promise.then((response) => {
        entry.headersAt = now();
        response
          .clone()
          .arrayBuffer()
          .then(() => {
            entry.doneAt = now();
          }, () => {});
      }, () => {});
    }
    return promise;
  };

  window.addEventListener(
    "keydown",
    (event) => {
      const stamp = event.timeStamp;
      state.keydowns.push(stamp);
      for (const measure of state.armed.values()) {
        if (measure.startOn === "keydown" && measure.start === null) {
          if (measure.key === undefined || measure.key === event.key) {
            measure.start = stamp;
          }
        }
      }
      if (state.typing !== null) {
        const editor = document.querySelector(state.typing.selector);
        if (editor !== null && event.key.length === 1) {
          state.typing.pending.push({
            stamp,
            expected: editor.textContent.length + 1,
          });
        }
      }
    },
    true,
  );
  window.addEventListener(
    "click",
    (event) => {
      const stamp = event.timeStamp;
      state.clicks.push(stamp);
      for (const measure of state.armed.values()) {
        if (measure.startOn === "click" && measure.start === null) {
          measure.start = stamp;
        }
      }
    },
    true,
  );

  const paletteText = () =>
    document.querySelector("[data-testid=command-palette]")?.innerText ?? "";

  const helpers = {
    now,
    optionCount: () =>
      document.querySelectorAll(
        "[data-testid=command-palette] [role=option]",
      ).length,
    paletteText,
    selectedOptionText: () =>
      document
        .querySelector("[data-testid=command-palette] [role=option][aria-selected=true]")
        ?.innerText.replace(/\s+/gu, " ")
        .trim()
        .slice(0, 80) ?? null,
    paletteInput: () =>
      document.querySelector("[data-testid=command-palette] input")?.value ??
      null,
    searchDone: (query) =>
      state.fetches.some(
        (entry) =>
          entry.doneAt !== null &&
          new URL(entry.url, location.href).searchParams.get("query") === query,
      ),
    threadVisible: (excludeId) => {
      const match = /\/threads\/([^/?#]+)/u.exec(location.pathname);
      if (match === null || match[1] === excludeId) return false;
      const prefix = `${match[1]}:`;
      for (const row of document.querySelectorAll("[data-timeline-row-id]")) {
        if (row.dataset.timelineRowId.startsWith(prefix)) return true;
      }
      return false;
    },
    threadId: () =>
      /\/threads\/([^/?#]+)/u.exec(location.pathname)?.[1] ?? null,
    sidebarRows: () =>
      document.querySelectorAll("a[data-sidebar-thread-id]").length,
    editorLength: () =>
      document.querySelector(".ProseMirror")?.textContent.length ?? 0,
  };

  function tick(name) {
    const measure = state.armed.get(name);
    if (measure === undefined || measure.done) return;
    if (measure.start === null) return;
    let ok = false;
    try {
      ok = measure.predicate(helpers);
    } catch {
      ok = false;
    }
    if (ok) {
      measure.done = true;
      requestAnimationFrame(() => {
        const at = now();
        measure.resolve({ ms: at - measure.start, at });
      });
    } else if (now() - measure.start > measure.timeoutMs) {
      measure.done = true;
      measure.resolve({ ms: null, timedOut: true });
    }
  }

  const tickAll = () => {
    for (const name of state.armed.keys()) tick(name);
    if (state.typing !== null) {
      const length = helpers.editorLength();
      const at = now();
      state.typing.pending = state.typing.pending.filter((entry) => {
        if (length >= entry.expected) {
          state.typing.latencies.push(at - entry.stamp);
          return false;
        }
        return true;
      });
    }
    requestAnimationFrame(tickAll);
  };
  requestAnimationFrame(tickAll);
  setInterval(() => {
    for (const name of state.armed.keys()) tick(name);
  }, 25);
  new MutationObserver(() => {
    for (const name of state.armed.keys()) tick(name);
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });

  window.__perf = {
    helpers,
    arm(name, predicateSource, { startOn, key, timeoutMs = 15000 } = {}) {
      const measure = {
        predicate: new Function("h", `return (${predicateSource})(h);`),
        startOn,
        key,
        timeoutMs,
        start: startOn === "now" ? now() : startOn === "origin" ? 0 : null,
        done: false,
        resolve: null,
        promise: null,
      };
      measure.promise = new Promise((resolve) => {
        measure.resolve = resolve;
      });
      state.armed.set(name, measure);
      return true;
    },
    async result(name) {
      const measure = state.armed.get(name);
      const timer = new Promise((resolve) =>
        setTimeout(() => resolve({ ms: null, timedOut: true }), measure.timeoutMs + 5000),
      );
      const value = await Promise.race([measure.promise, timer]);
      state.armed.delete(name);
      return value;
    },
    startTyping(selector) {
      state.typing = { selector, pending: [], latencies: [] };
    },
    stopTyping() {
      const latencies = state.typing?.latencies ?? [];
      const unresolved = state.typing?.pending.length ?? 0;
      state.typing = null;
      return { latencies, unresolved };
    },
    pushPath(path) {
      history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    resourceCount: () => performance.getEntriesByType("resource").length,
    resource: (fragment) => {
      const entry = performance
        .getEntriesByType("resource")
        .find((candidate) => candidate.name.includes(fragment));
      return entry === undefined
        ? null
        : { duration: entry.duration, start: entry.startTime };
    },
    startup: () => {
      const nav = performance.getEntriesByType("navigation")[0];
      const paint = performance
        .getEntriesByType("paint")
        .find((entry) => entry.name === "first-contentful-paint");
      const resources = performance.getEntriesByType("resource");
      return {
        fcp: paint?.startTime ?? null,
        domContentLoaded: nav?.domContentLoadedEventEnd ?? null,
        load: nav?.loadEventEnd ?? null,
        requests: resources.length,
        transferKb:
          resources.reduce((sum, entry) => sum + (entry.transferSize ?? 0), 0) /
          1024,
      };
    },
    rect: (selector, index = 0) => {
      const element = document.querySelectorAll(selector)[index];
      if (element === undefined) return null;
      element.scrollIntoView({ block: "center" });
      const box = element.getBoundingClientRect();
      return {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        id: element.dataset.sidebarThreadId ?? null,
      };
    },
  };
})();
