import { expect, it } from "vitest";
import { storageRpc } from "./contract.js";
import { cleanupInputSchema } from "./storage-types.js";
import {
  EXTERNAL_WORKTREE_REMOVAL_LIMIT,
  limitExternalWorktrees,
} from "./worktree-selection.js";

const paths = (count: number) =>
  Array.from({ length: count }, (_, index) => `/fixture/worktrees/${index}`);

it("keeps the selection limit equal to what both removal calls accept", () => {
  const accepted = (count: number) =>
    cleanupInputSchema.safeParse({
      hostId: "host_test",
      kind: "externalWorktrees",
      paths: paths(count),
      force: false,
    }).success &&
    storageRpc.removeExternalWorktrees.input.safeParse({
      hostId: "host_test",
      paths: paths(count),
      force: false,
    }).success;
  expect(accepted(EXTERNAL_WORKTREE_REMOVAL_LIMIT)).toBe(true);
  expect(accepted(EXTERNAL_WORKTREE_REMOVAL_LIMIT + 1)).toBe(false);
});

it("limits a selection to the removal limit in order and leaves smaller ones alone", () => {
  const many = paths(EXTERNAL_WORKTREE_REMOVAL_LIMIT + 7);
  const limited = limitExternalWorktrees(many);
  expect(limited).toHaveLength(EXTERNAL_WORKTREE_REMOVAL_LIMIT);
  expect(limited).toEqual(many.slice(0, EXTERNAL_WORKTREE_REMOVAL_LIMIT));
  expect(limitExternalWorktrees(paths(3))).toEqual(paths(3));
});
