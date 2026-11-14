import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { NewChatPage } from "./NewChatPage.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(async () => ({ id: "new-thread" })),
  toThread: vi.fn(),
  composer: vi.fn(
    (_props: { onSubmit(request: NewThreadRequest): Promise<void> }) => null,
  ),
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_NewThreadComposer: mocks.composer,
  experimental_useSidebarThreads: () => ({ threads: [], projects: [] }),
  ThreadTitle: () => null,
  useBbNavigate: () => ({ toThread: mocks.toThread }),
  useComposers: () => [],
  useSdk: () => ({ threads: { spawn: mocks.spawn } }),
}));
vi.mock("../sidebar/prefs.js", () => ({ useLastActiveThreads: () => ({}) }));
vi.mock("@/components/ui/icon", () => ({ Icon: () => null }));
vi.mock("../tabs/WorkspaceTabs.js", () => ({ TabStrip: () => null }));
vi.mock("../workspace.js", () => ({
  findWorkspace: () => ({
    chats: [],
    projectId: "project-1",
    label: "workspace",
  }),
}));
vi.mock("./active.js", () => ({ useMarkNewChatEnvironment: () => undefined }));

it("tags a new-chat composer submission and navigates to the spawned thread", async () => {
  renderToStaticMarkup(<NewChatPage subPath="environment-1" />);
  const request: NewThreadRequest = {
    projectId: "project-1",
    providerId: "codex",
    model: "test-model",
    reasoningLevel: "medium",
    permissionMode: "full",
    executionInputSources: {},
    environment: { type: "reuse", environmentId: "environment-1" },
    input: [{ type: "text", text: "Continue", mentions: [] }],
  };
  await mocks.composer.mock.calls[0]![0].onSubmit(request);
  expect(mocks.spawn).toHaveBeenCalledWith({
    ...request,
    wakeCause: "message",
    wakeRef: expect.any(String),
  });
  expect(mocks.toThread).toHaveBeenCalledWith("new-thread");
});
