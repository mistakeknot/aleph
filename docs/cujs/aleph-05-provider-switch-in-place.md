---
artifact_type: cuj
journey: provider-switch-in-place
actor: solo operator
criticality: p2
---

# Switch a thread's provider in place

## Why This Journey Matters

Sometimes the operator wants a thread to continue on a different provider:
its accounts are exhausted, the other model suits the next step, or they
want a second opinion on the same work. bb's standard handoff starts a new
thread. That works, but the new thread appears somewhere else in the list
without the original's title, pin, section, parent or children. The operator
then has to put it back where it belongs, or ends up with two threads for
the same piece of work.

For someone managing dozens of threads, mostly from a phone, where a thread
sits in the list is how they find it. A switch that loses its place creates
real cost later.

### Current State vs. Planned

| Capability | Status |
|---|---|
| "Switch in this thread" in the model picker when changing provider | **Shipped** (needs the local handoff plugin) |
| New thread takes over title, pin, section, parent and children; original archived | **Shipped** |
| "New thread" keeps bb's standard handoff | **Shipped** |
| Provider icons in the thread list show the new provider | **Shipped** |
| Same switch from the `bb` CLI | **Planned** (not yet confirmed) |

## The Journey

The operator opens the model picker on a Claude thread and chooses a Codex
model. The local handoff plugin is running, so the picker offers **Switch
in this thread** as the default. They confirm.

bb hands the thread's context off to Codex. The new thread takes over the
original's title, pin, section, parent and children, and the original is
archived. In the thread list, the row appears in the same section, pinned
if the original was, and its provider icon now shows Codex. Child threads are still under it and the parent still
sees it.

If the operator wants a separate thread instead, **New thread** is still
there and behaves as upstream bb does. Without the handoff plugin, the picker
offers only bb's standard behavior.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Place in the list is kept | measurable | active | After the switch, the new thread has the original's title, pin state and section |
| Tree is kept | measurable | active | The original's parent and children are the new thread's parent and children |
| Original is archived, not deleted | measurable | active | The original thread is archived and still readable |
| Default only when supported | observable | active | Without the handoff plugin, "Switch in this thread" isn't offered |
| Provider is visible | observable | active | The row's provider icon changes to the new provider |
| Operator doesn't have to re-file | qualitative | active | The operator finds the switched thread where they left it, without searching |
| CLI parity | measurable | planned | The same switch is available through the `bb` CLI with the same result |

## Known Friction Points

- **Depends on a local plugin.** Without the handoff plugin, the default
  isn't available.
- **CLI and SDK surface not confirmed.** bb's rule is that every feature is
  usable from the CLI and SDK. That hasn't been checked for this switch.
- **Two threads in history.** The archived original remains, which is
  deliberate but can confuse search results.
