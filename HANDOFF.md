# Worktree drag-to-parent reviewer handoff

## Issue and solution

Dragging a worktree/environment group onto a thread could not create a parent relationship because grouped drags were excluded from thread-row nest targets. Thread nesting also felt unreliable because the valid vertical band was narrow, hover activation was slow, and horizontal cancellation used the dragged card edge rather than the pointer.

The fix adds a `nest-group` decision that reparents only the worktree group's root threads, preserving descendants and rejecting cycles. The target band is now the middle 70% of the row, expands to the whole row once armed, activates after 200 ms, and uses the pointer with 12 px of left-side tolerance.

- Pull request: pending creation
- Related issue: [#3029](https://github.com/get-bb/bb/issues/3029) covers stale sidebar placement after a different reparenting path; this change does not close it.

## Visual evidence

| Before | Valid drag target | After drop |
| --- | --- | --- |
| ![Worktree group before reparenting](docs/handoff-assets/worktree-dnd-before.png) | ![Parent thread outlined as a valid target](docs/handoff-assets/worktree-dnd-target.png) | ![Worktree group nested under the parent thread](docs/handoff-assets/worktree-dnd-after.png) |

## Focused verification

- `pnpm exec turbo run test --filter=bb-plugin-thread-list --force -- --run app/dnd/useSectionThreadDnd.test.ts app/dnd/useSectionThreadDnd.projection.test.tsx` — 44 passed
- `pnpm exec turbo run typecheck --filter=bb-plugin-thread-list --force` — passed
- `pnpm exec turbo run test --filter=@bb/app --force -- --run src/components/sidebar/useSectionThreadDnd.test.ts src/components/sidebar/useSectionThreadDnd.projection.test.tsx` — 44 passed
- `pnpm exec turbo run typecheck --filter=@bb/app --force` — passed
- Source-app smoke test confirmed both group roots persisted the target `parentThreadId`, the hierarchy updated immediately, and it survived reload.
- Current CI: pending PR creation; use the PR checks link after creation.

The verification inventory also reports pre-existing recipe drift: `Unmapped CLI family: browser; add recipes and an explicit owner`.

## Live reviewer fixture

The preview URL, fixture IDs, exact reset commands, and persisted-state checks are added after the live fixture is seeded.
