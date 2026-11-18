// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  createDocumentSession,
  useDocumentSession,
  type DocumentWriter,
} from "./document-session.js";

it("flushes per lifecycle event and removes listeners while keeping unmount flush", () => {
  const session = createDocumentSession({
    path: "notes.md",
    showsProposals: false,
    delay: 700,
  });
  const flush = vi.spyOn(session, "flush").mockResolvedValue(undefined);
  const view = renderHook(() =>
    useDocumentSession(session, {
      snapshot: undefined,
      error: null,
      writer: {} as DocumentWriter,
    }),
  );
  window.dispatchEvent(new Event("pagehide"));
  expect(flush).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(flush).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(flush).toHaveBeenCalledTimes(3);
  window.dispatchEvent(new Event("pagehide"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(flush).toHaveBeenCalledTimes(3);
});
