import { describe, expect, it } from "vitest";
import {
  foldDescribePairs,
  parseRequest,
  resolveDestinationPath,
} from "./request-args.js";

const base = {
  names: ["API_KEY"],
  project: "demo",
  purpose: undefined,
  describe: [] as string[],
  writeEnv: ".env",
};

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("request parser (T1.1)", () => {
  it("accepts a plain request", () => {
    const parsed = parseRequest({
      ...base,
      names: ["A_B", "_C"],
      purpose: "Deploy",
      describe: ["A_B=First"],
    });
    expect(parsed.names).toEqual(["A_B", "_C"]);
    expect(parsed.descriptions.get("A_B")).toBe("First");
    expect(parsed.purpose).toBe("Deploy");
  });

  it("rejects NAME=value positionals without echoing the value", () => {
    let message = "";
    try {
      parseRequest({ ...base, names: ["API_KEY=hunter2value"] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("hunter2value");
    expect(codeOf(() => parseRequest({ ...base, names: ["A=b"] }))).toBe(
      "value_in_argv",
    );
  });

  it.each(["1BAD", "has-dash", "has space", "", "ünï"])(
    "rejects the bad name %j",
    (name) => {
      expect(codeOf(() => parseRequest({ ...base, names: [name] }))).toBe(
        "invalid_variable_name",
      );
    },
  );

  it("rejects duplicate names, unrequested descriptions and bad projects", () => {
    expect(codeOf(() => parseRequest({ ...base, names: ["A", "A"] }))).toBe(
      "duplicate_variable_name",
    );
    expect(codeOf(() => parseRequest({ ...base, describe: ["OTHER=x"] }))).toBe(
      "unrequested_describe",
    );
    expect(
      codeOf(() =>
        parseRequest({ ...base, describe: ["API_KEY=a", "API_KEY=b"] }),
      ),
    ).toBe("duplicate_describe");
    for (const project of ["", "../x", "a/b", "-lead"]) {
      expect(codeOf(() => parseRequest({ ...base, project }))).toBe(
        "invalid_project",
      );
    }
  });

  it("rejects multi-line and over-long free text", () => {
    expect(codeOf(() => parseRequest({ ...base, purpose: "a\nb" }))).toBe(
      "invalid_text",
    );
    expect(
      codeOf(() => parseRequest({ ...base, purpose: "x".repeat(501) })),
    ).toBe("text_too_long");
  });

  it("folds two-token describe pairs and leaves other argv alone", () => {
    expect(
      foldDescribePairs(["--describe", "API_KEY", "the key", "--json"]),
    ).toEqual(["--describe=API_KEY=the key", "--json"]);
    expect(foldDescribePairs(["--describe", "API_KEY=x"])).toEqual([
      "--describe",
      "API_KEY=x",
    ]);
  });
});

describe("destination path (T1.1)", () => {
  it("joins relative paths onto the working directory", () => {
    expect(resolveDestinationPath("/work/app", ".env")).toBe("/work/app/.env");
    expect(resolveDestinationPath("/work/app", "sub/.env")).toBe(
      "/work/app/sub/.env",
    );
  });

  it("keeps a normalized absolute path", () => {
    expect(resolveDestinationPath("/work/app", "/srv/x/.env")).toBe(
      "/srv/x/.env",
    );
  });

  it.each([
    "../.env",
    "a/../.env",
    "./.env",
    "a/./.env",
    "a//.env",
    "/a//.env",
    "dir/",
    "a\\b",
    "a\0b",
  ])("rejects the non-normalized path %j", (candidate) => {
    expect(codeOf(() => resolveDestinationPath("/work/app", candidate))).toBe(
      "path_not_normalized",
    );
  });
});
