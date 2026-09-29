// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FollowUpSubmitMode } from "@bb/client-core";
import type { BbDesktopDiagnosticEvent } from "@bb/desktop-contract";
import { onDiagnostic } from "@/lib/diagnostics";
import {
  describeComposerSendState,
  useComposerSendStateDiagnostic,
} from "./composer-send-state";

const READY: FollowUpSubmitMode = { kind: "ready" };
const BLOCKED: FollowUpSubmitMode = {
  kind: "blocked",
  reason: "loading-pending-interactions",
};

const INITIAL_PROPS: { mode: FollowUpSubmitMode; status: string } = {
  mode: READY,
  status: "idle",
};

describe("describeComposerSendState", () => {
  it("names every blocked reason and prefers it over submitting", () => {
    expect(
      describeComposerSendState({
        isFollowUpSubmitting: true,
        submitMode: BLOCKED,
      }),
    ).toBe("blocked-loading-pending-interactions");
    expect(
      describeComposerSendState({
        isFollowUpSubmitting: true,
        submitMode: READY,
      }),
    ).toBe("submitting");
    expect(
      describeComposerSendState({
        isFollowUpSubmitting: false,
        submitMode: { kind: "queue-while-stopping" },
      }),
    ).toBe("queue-while-stopping");
  });
});

describe("useComposerSendStateDiagnostic", () => {
  const events: BbDesktopDiagnosticEvent[] = [];
  let unsubscribe = () => {};

  afterEach(() => {
    unsubscribe();
    events.length = 0;
  });

  function listen(): void {
    unsubscribe = onDiagnostic((event) => events.push(event));
  }

  function composerEvents() {
    return events.flatMap((event) =>
      event.kind === "composer-send-state" ? [event] : [],
    );
  }

  it("logs the reason only when it changes, with the previous reason", () => {
    listen();
    const { rerender } = renderHook(
      (props: { mode: FollowUpSubmitMode; status: string }) =>
        useComposerSendStateDiagnostic({
          isFollowUpSubmitting: false,
          runtimeStatus: props.status,
          submitMode: props.mode,
          threadId: "thr_1",
        }),
      { initialProps: INITIAL_PROPS },
    );
    rerender({ mode: READY, status: "idle" });
    rerender({ mode: READY, status: "idle" });
    expect(composerEvents()).toHaveLength(1);
    rerender({ mode: BLOCKED, status: "idle" });
    rerender({ mode: BLOCKED, status: "idle" });
    rerender({ mode: READY, status: "idle" });
    expect(
      composerEvents().map(({ previous, state }) => [previous, state]),
    ).toEqual([
      [null, "ready"],
      ["ready", "blocked-loading-pending-interactions"],
      ["blocked-loading-pending-interactions", "ready"],
    ]);
    expect(composerEvents()[1]).toMatchObject({
      runtimeStatus: "idle",
      threadId: "thr_1",
    });
  });

  it("does not carry the previous state across threads", () => {
    listen();
    const { rerender } = renderHook(
      (props: { threadId: string }) =>
        useComposerSendStateDiagnostic({
          isFollowUpSubmitting: false,
          runtimeStatus: null,
          submitMode: READY,
          threadId: props.threadId,
        }),
      { initialProps: { threadId: "thr_1" } },
    );
    rerender({ threadId: "thr_2" });
    expect(
      composerEvents().map(({ previous, threadId }) => [threadId, previous]),
    ).toEqual([
      ["thr_1", null],
      ["thr_2", null],
    ]);
  });
});
