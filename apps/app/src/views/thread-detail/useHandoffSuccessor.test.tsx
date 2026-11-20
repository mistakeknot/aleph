// @vitest-environment jsdom
import {
  renderHook,
  act,
  waitFor,
  render,
  screen,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  useHandoffSuccessor,
  HandoffNotice,
  followLocalHandoff,
} from "./useHandoffSuccessor";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  signals: new Set<(event: unknown) => void>(),
}));
vi.mock("@/lib/plugin-sdk-hooks", () => ({ callPluginRpc: mocks.rpc }));
vi.mock("@/lib/ws", () => ({
  wsManager: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    onPluginSignal: (cb: (event: unknown) => void) => {
      mocks.signals.add(cb);
      return () => mocks.signals.delete(cb);
    },
  },
}));
vi.mock("@/hooks/useServerConnectionState", () => ({
  useServerConnectionState: () => "connected",
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});
it("follows in place live, carries a source draft without clearing either draft, and dismisses its notice", async () => {
  mocks.rpc.mockResolvedValue(null);
  const navigate = vi.fn();
  const source = getPromptDraftAccessor({
    kind: "thread",
    projectId: "project",
    threadId: "source",
  });
  const target = getPromptDraftAccessor({
    kind: "thread",
    projectId: "project",
    threadId: "target",
  });
  source.setDraft({ text: "unfinished", mentions: [], attachments: [] });
  target.setDraft({ text: "existing", mentions: [], attachments: [] });
  const { result } = renderHook(() =>
    useHandoffSuccessor({
      threadId: "source",
      projectId: "project",
      title: "Source",
      archivedAt: null,
      navigateInPane: navigate,
    }),
  );
  renderHook(() =>
    useHandoffSuccessor({
      threadId: "source",
      projectId: "project",
      title: "Source",
      archivedAt: null,
      navigateInPane: navigate,
    }),
  );
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
  mocks.rpc.mockResolvedValue({
    threadId: "target",
    projectId: "project",
    title: "Target",
  });
  act(() =>
    mocks.signals.forEach((cb) =>
      cb({ pluginId: "handoff", channel: "handoff:replaced" }),
    ),
  );
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      threadId: "target",
      projectId: "project",
    }),
  );
  expect(target.getCurrent().text).toBe("existing\n\nunfinished");
  expect(source.getCurrent().text).toBe("unfinished");
  render(
    <HandoffNotice
      notice={result.current.notice}
      onDismiss={result.current.dismiss}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("Source → Target");
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss handoff notice" }),
  );
  expect(result.current.notice).toBeNull();
});
it("resolves an archived URL on mount and ignores an absent older plugin", async () => {
  const navigate = vi.fn();
  mocks.rpc.mockRejectedValue(new Error("unknown method"));
  const { rerender } = renderHook(
    ({ id }) =>
      useHandoffSuccessor({
        threadId: id,
        projectId: "project",
        title: "Source",
        archivedAt: 1,
        navigateInPane: navigate,
      }),
    { initialProps: { id: "ordinary" } },
  );
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
  expect(navigate).not.toHaveBeenCalled();
  mocks.rpc.mockResolvedValue({
    threadId: "final",
    projectId: "project",
    title: "Final",
  });
  rerender({ id: "archived" });
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      threadId: "final",
      projectId: "project",
    }),
  );
});

it("keeps a local switch in its source panes and leaves other panes alone", () => {
  mocks.rpc.mockResolvedValue(null);
  const sourceNavigate = vi.fn();
  const otherNavigate = vi.fn();
  const { result, rerender } = renderHook(
    ({ threadId }) =>
      useHandoffSuccessor({
        threadId,
        projectId: "local-project",
        title: "Local",
        archivedAt: null,
        navigateInPane: sourceNavigate,
      }),
    { initialProps: { threadId: "local-source" } },
  );
  renderHook(() =>
    useHandoffSuccessor({
      threadId: "other",
      projectId: "local-project",
      title: "Other",
      archivedAt: null,
      navigateInPane: otherNavigate,
    }),
  );
  act(() => {
    expect(
      followLocalHandoff("local-source", {
        projectId: "local-project",
        threadId: "local-target",
      }),
    ).toBe(true);
  });
  expect(sourceNavigate).toHaveBeenCalledWith({
    projectId: "local-project",
    threadId: "local-target",
  });
  expect(otherNavigate).not.toHaveBeenCalled();
  expect(result.current.notice?.from).toBe("Local");
  rerender({ threadId: "local-target" });
  expect(result.current.notice).not.toBeNull();
  rerender({ threadId: "unrelated" });
  expect(result.current.notice).toBeNull();
});

it("refuses a lookup response pointing into another project", async () => {
  mocks.rpc.mockResolvedValue({
    threadId: "foreign",
    projectId: "foreign-project",
    title: "Foreign",
  });
  const navigate = vi.fn();
  renderHook(() =>
    useHandoffSuccessor({
      threadId: "guard-source",
      projectId: "project",
      title: "Source",
      archivedAt: 1,
      navigateInPane: navigate,
    }),
  );
  await act(async () => {});
  expect(navigate).not.toHaveBeenCalled();
});
