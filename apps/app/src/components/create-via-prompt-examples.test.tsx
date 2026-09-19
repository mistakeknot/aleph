// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { PluginCreateButton } from "./plugin/PluginCreateButton";
import {
  CreateWithTemplatesButton,
  getCreateExamples,
} from "./create-via-prompt-examples";
import {
  UTILITY_EXAMPLES,
  briefPrompt,
} from "./plugin/browse-hero/browse-hero-archetypes";

afterEach(cleanup);

describe.each([false, true])(
  "plugin creation menu (compact: %s)",
  (compact) => {
    function setup() {
      const onCreate = vi.fn();
      const onInstallFromSource = vi.fn();
      render(
        <CompactViewportOverrideProvider isCompactViewport={compact}>
          <PluginCreateButton
            onCreate={onCreate}
            onInstallFromSource={onInstallFromSource}
          />
        </CompactViewportOverrideProvider>,
      );
      const open = async () => {
        const trigger = screen.getByRole("button", {
          name: "New plugin options",
        });
      if (compact) fireEvent.click(trigger);
      else fireEvent.keyDown(trigger, { key: "Enter" });
        await screen.findByRole("menuitem", { name: "Examples" });
      };
      return { onCreate, onInstallFromSource, open };
    }

    it("keeps installation direct and returns template choices to the existing composer", async () => {
      const { onCreate, onInstallFromSource, open } = setup();
      await open();
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["Install from source", "Examples", "Capabilities"]);
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Install from source" }),
      );
      expect(onInstallFromSource).toHaveBeenCalledOnce();
      for (const [group, example] of [
        ["Examples", getCreateExamples("plugin").examples[0]],
        [
          "Capabilities",
          { ...UTILITY_EXAMPLES[0], prompt: briefPrompt(UTILITY_EXAMPLES[0]) },
        ],
      ] as const) {
        await open();
        fireEvent.click(screen.getByRole("menuitem", { name: group }));
        const choice = await screen.findByRole("menuitem", {
          name: new RegExp(`^${example.label}`),
        });
        await waitFor(() => expect(document.activeElement).toBe(choice));
        fireEvent.click(choice);
        expect(onCreate).toHaveBeenLastCalledWith(example.prompt);
        await waitFor(() =>
          expect(
            screen.queryByRole("menuitem", {
              name: new RegExp(`^${example.label}`),
            }),
          ).toBeNull(),
        );
      }
    });

    it("restores the group on Back and resets to the root after dismissal", async () => {
      const { open, onCreate } = setup();
      await open();
      fireEvent.keyDown(
        screen.getByRole("menuitem", { name: "Capabilities" }),
        { key: "ArrowRight" },
      );
      const back = await screen.findByRole("menuitem", { name: "New plugin" });
      fireEvent.click(back);
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("menuitem", { name: "Capabilities" }),
        ),
      );
      fireEvent.click(screen.getByRole("menuitem", { name: "Examples" }));
      fireEvent.keyDown(
        await screen.findByRole("menuitem", { name: "New plugin" }),
        { key: "Escape" },
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("menuitem", { name: "New plugin" }),
        ).toBeNull(),
      );
      await open();
      expect(screen.getAllByRole("menuitem")).toHaveLength(3);
      expect(onCreate).not.toHaveBeenCalled();
    });
  },
);

it("keeps the single skill example list directly accessible", () => {
  render(
    <CreateWithTemplatesButton
      kind="skill"
      label="New skill"
      onCreate={() => undefined}
    />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "New skill options" }), {
    key: "Enter",
  });
  expect(screen.getByRole("menuitem", { name: /^PR review/ })).toBeTruthy();
});
