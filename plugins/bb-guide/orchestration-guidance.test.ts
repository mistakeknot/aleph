import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { introduction } from "./introduction.js";

const surfaces = [
  { name: "introduction", text: introduction },
  {
    name: "skill",
    text: readFileSync(
      new URL("./skills/bb-cli/SKILL.md", import.meta.url),
      "utf8",
    ),
  },
  {
    name: "template",
    text: readFileSync(
      new URL(
        "../../packages/templates/src/templates/bb-guide-threads.md",
        import.meta.url,
      ),
      "utf8",
    ),
  },
];

describe.each(surfaces)("$name orchestration guidance", ({ text: source }) => {
  const text = source.replace(/\s+/g, " ").trim();

  it("makes the BB session orchestration path discoverable", () => {
    expect(text).toContain("bb thread spawn");
    expect(text).toContain("--parent-self");
    expect(text).toContain("--new-environment worktree");
    expect(text).toContain("--parent-notifications auto");
    expect(text).toContain("bb thread wait");
  });

  it("requires explicit BB authority rather than generic delegation", () => {
    expect(text).toContain(
      "Spawn worker threads only when the user explicitly requests BB orchestration or explicitly requests BB child-session delegation.",
    );
    expect(text).toContain("Generic delegation alone authorizes neither.");
    expect(text).not.toMatch(/BB orchestration or delegation/);
  });

  it("conditions integration on task authority and validated successful output", () => {
    expect(text).toContain(
      "Integrate worker branches only when the original task authorizes code changes and you have validated successful worker output as suitable for that task.",
    );
    expect(text).toContain(
      "Otherwise, collect and report results without integrating.",
    );
    expect(text).toContain("Run relevant tests after authorized integration.");
    expect(text).not.toMatch(/(?:then integrate|and integrating workers)/);
  });

  it("preserves external permission, review, and publication gates", () => {
    expect(text).toContain(
      "Preserve all external permission, review, and publication gates.",
    );
    expect(text).toContain(
      "Orchestration authorization does not authorize permission bypasses, merging into a protected main branch, pushing, or publishing.",
    );
  });

  it("distinguishes timeout from completion and actual errors", () => {
    expect(text).toContain(
      "A wait timeout does not mean completion: inspect state and repeat the wait while the worker is still running.",
    );
    expect(text).toContain("Stop on actual errors");
    expect(text).toContain("bb thread show <id> --json");
    expect(text).toContain("bb thread log <id>");
  });

  it("distinguishes manually created worktrees from BB management", () => {
    expect(text).toContain(
      "provider-native subagents can use manually-created worktrees, but do not create BB-managed child sessions, worktrees, or parent notifications.",
    );
  });
});
