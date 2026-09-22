# Worktree drag-to-parent reviewer handoff

## Issue and solution

Dragging a worktree/environment group onto a thread could not create a parent relationship because grouped drags were excluded from thread-row nest targets. Thread nesting also felt unreliable because the valid vertical band was narrow, hover activation was slow, and horizontal cancellation used the dragged card edge rather than the pointer.

The fix adds a `nest-group` decision that reparents only the worktree group's root threads, preserving descendants and rejecting cycles. The target band is now the middle 70% of the row, expands to the whole row once armed, activates after 200 ms, and uses the pointer with 12 px of left-side tolerance.

- Pull request: [#4078](https://github.com/get-bb/bb/pull/4078)
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
- Current CI at handoff: focused local checks pass; the initial PR run has eight passing, six running, and two intentionally skipped checks. Follow the [live PR checks](https://github.com/get-bb/bb/pull/4078/checks).

The verification inventory also reports pre-existing recipe drift: `Unmapped CLI family: browser; add recipes and an explicit owner`.

## Live reviewer fixture

- Preview: [BB Connect source build](https://ymichael--24976.getbb.app)
- Project: `Worktree drag review` (`proj_mgv855fe5d`)
- Group: `Reviewer worktree group` (`env_viznrhpzke`)
- Roots: `Worktree root A` (`thr_d768km8z9q`) and `Worktree root B` (`thr_3u5ntwpz98`)
- Target: `Drop worktree here` (`thr_dsgc8btyaw`)

In the sidebar thread menu, choose **Organize → Custom** and enable **By environment**. Drag the `Reviewer worktree group` row onto the center of `Drop worktree here`, wait for the target outline, and release. Both roots should appear beneath the target while remaining in one worktree group.

The source server is running at `http://127.0.0.1:24976`. From this worktree, reset the fixture with:

```sh
env -u BB_PROJECT_ID -u BB_THREAD_ID -u BB_HOST_ID BB_SERVER_URL=http://127.0.0.1:24976 node apps/cli/dist/index.js thread update thr_d768km8z9q --clear-parent-thread
env -u BB_PROJECT_ID -u BB_THREAD_ID -u BB_HOST_ID BB_SERVER_URL=http://127.0.0.1:24976 node apps/cli/dist/index.js thread update thr_3u5ntwpz98 --clear-parent-thread
```

Verify persisted state with:

```sh
for review_id in thr_d768km8z9q thr_3u5ntwpz98; do
  env -u BB_PROJECT_ID -u BB_THREAD_ID -u BB_HOST_ID BB_SERVER_URL=http://127.0.0.1:24976 node apps/cli/dist/index.js thread show "$review_id" --json | jq '.thread | {id, parentThreadId, environmentId}'
done
```

After the drag, each `parentThreadId` must be `thr_dsgc8btyaw` and each `environmentId` must remain `env_viznrhpzke`. After reset, each `parentThreadId` must be `null`. Both transitions were exercised against the live fixture before handoff.
