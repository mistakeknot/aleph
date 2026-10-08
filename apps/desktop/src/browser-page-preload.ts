import { contextBridge, ipcRenderer } from "electron";
import {
  BB_DESKTOP_BROWSER_EDITABLE_FOCUS_CHANNEL,
  BB_DESKTOP_BROWSER_GUEST_MESSAGE_CHANNEL,
  BB_DESKTOP_BROWSER_PAGE_BRIDGE_KEY,
  BB_DESKTOP_BROWSER_PAGE_WORLD_ID,
} from "./desktop-browser-ipc.js";
import {
  activeSameOriginFrameWindows,
  hasEditableFocus,
} from "@bb/domain/editable-focus";

contextBridge.exposeInIsolatedWorld(
  BB_DESKTOP_BROWSER_PAGE_WORLD_ID,
  BB_DESKTOP_BROWSER_PAGE_BRIDGE_KEY,
  {
    postMessage(channel: unknown, data: unknown): void {
      ipcRenderer.send(BB_DESKTOP_BROWSER_GUEST_MESSAGE_CHANNEL, {
        channel,
        data,
      });
    },
  },
);

let lastReportedEditableFocus = false;

function reportEditableFocus(): void {
  const editable = hasEditableFocus(document);
  if (editable === lastReportedEditableFocus) return;
  lastReportedEditableFocus = editable;
  ipcRenderer.send(BB_DESKTOP_BROWSER_EDITABLE_FOCUS_CHANNEL, editable);
}

const observedWindows = new WeakSet<Window>();

function refreshEditableFocus(): void {
  for (const frameWindow of activeSameOriginFrameWindows(document)) {
    observeFocus(frameWindow);
  }
  reportEditableFocus();
}

function observeFocus(target: Window): void {
  if (observedWindows.has(target)) return;
  observedWindows.add(target);
  for (const type of ["focus", "focusin", "blur", "focusout"]) {
    target.addEventListener(
      type,
      () => {
        refreshEditableFocus();
        setTimeout(refreshEditableFocus, 0);
      },
      true,
    );
  }
}

observeFocus(window);
