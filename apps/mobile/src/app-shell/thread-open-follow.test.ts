import { describe, expect, it } from "vitest";
import { shouldFollowThreadOpen } from "./thread-open-follow";

describe("shouldFollowThreadOpen", () => {
  it("does not follow when the user is already in a thread screen", () => {
    expect(shouldFollowThreadOpen("/threads/t1")).toBe(false);
    expect(shouldFollowThreadOpen("/shell/threads/t1")).toBe(false);
    expect(shouldFollowThreadOpen("/webview")).toBe(false);
  });

  it("follows from a screen that is not a thread", () => {
    expect(shouldFollowThreadOpen("/")).toBe(true);
    expect(shouldFollowThreadOpen("/settings")).toBe(true);
  });
});
