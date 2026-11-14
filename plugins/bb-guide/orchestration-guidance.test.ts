import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { introduction } from "./introduction.js";

it("makes the BB session orchestration path discoverable before delegation", () => {
  const skill = readFileSync(new URL("./skills/bb-cli/SKILL.md", import.meta.url), "utf8");
  for (const text of [introduction, skill]) {
    expect(text).toContain("bb thread spawn");
    expect(text).toContain("--parent-self");
    expect(text).toContain("--new-environment worktree");
    expect(text).toContain("--parent-notifications auto");
    expect(text).toContain("bb thread wait");
    expect(text).toContain("provider-native subagents");
  }
});
