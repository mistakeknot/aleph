import { describe, expect, it } from "vitest";
import type { ExperimentalPluginCommandPaletteSearchRegistration } from "../app-contract.js";
import { collectPluginAppRegistrations } from "./plugin-app-collector.js";

function collect(
  ...registrations: ExperimentalPluginCommandPaletteSearchRegistration[]
) {
  return collectPluginAppRegistrations({
    __bbPluginApp: true,
    setup(app) {
      for (const registration of registrations) {
        app.slots.experimental_commandPaletteSearch(registration);
      }
    },
  });
}

const search = async () => [];

describe("slots.experimental_commandPaletteSearch", () => {
  it("collects a valid registration", () => {
    const collected = collect({ id: "tasks", title: "Tasks", search });
    expect(collected.commandPaletteSearches).toEqual([
      { id: "tasks", title: "Tasks", search },
    ]);
  });

  it("rejects a missing search function", () => {
    expect(() =>
      collect({
        id: "tasks",
        title: "Tasks",
      } as unknown as ExperimentalPluginCommandPaletteSearchRegistration),
    ).toThrow(
      'slots.experimental_commandPaletteSearch: "search" must be a function',
    );
  });

  it("rejects a duplicate id", () => {
    expect(() =>
      collect(
        { id: "tasks", title: "Tasks", search },
        { id: "tasks", title: "More tasks", search },
      ),
    ).toThrow(/duplicate id "tasks"/u);
  });

  it("rejects an empty title", () => {
    expect(() => collect({ id: "tasks", title: "", search })).toThrow(
      /"title"/u,
    );
  });

  it("rejects a malformed id", () => {
    expect(() => collect({ id: "has space", title: "Tasks", search })).toThrow(
      /slots\.experimental_commandPaletteSearch/u,
    );
  });
});
