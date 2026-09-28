# A status chip in the header bar's center

`app.slots.experimental_appHeaderStatus` renders a compact status chip in the
header bar's center, sharing width with breadcrumbs and the thread title.
Many plugins can contribute; the host shows them in ascending plugin id
order, then registration order, and collapses the strip before it displaces
breadcrumbs or the thread title.

```tsx
app.slots.experimental_appHeaderStatus({
  id: "sync",
  title: "Sync status",
  component: ({
    threadId,
    projectId,
    isCompactViewport,
    availableWidth,
    openSettings,
  }) => { ... },
});
```

The component receives `threadId` and `projectId`, both nullable off a
thread route or when none is selected, and `isCompactViewport` — true on
phone-width viewports and coarse pointers, where you should collapse to a
single icon-sized control. `availableWidth` is the strip's available width
divided evenly across every current contribution, updated as the window
resizes, other contributions register or unregister, or breadcrumbs and the
thread title change length; measure your rendered width against this budget
and switch to a narrower presentation rather than overflowing. Call
`openSettings()` to navigate to this plugin's detail page in Tools, where
`settingsSection` slots render. The host renders each contribution once per
window regardless of split panes — never once per pane — so keep state in
the component, not a module-level singleton keyed by thread.
