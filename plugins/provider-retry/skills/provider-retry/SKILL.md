---
name: provider-retry
description: "Diagnose automatic retries of BB turns after provider subscription-window limits."
---

# Provider retry

The plugin is enabled on fresh installations. When a turn fails on a structured
Codex or Claude Code subscription-window limit with a reset time, it queues the
original input verbatim for after the window opens, marked agent-only.

A pending retry is an ordinary durable queued row and survives restart. Inspect
it with `bb thread queue list <thread-id>` and inspect the failed turn before
manually retrying it; avoid duplicating an existing queued retry.

Use the core `bb thread retry` command for an intentional manual retry. Follow
its live help for selection and scheduling flags.

When a caller owns retries for a thread (an orchestrator that retries or falls
back on its own), run `bb provider-retry disable <thread-id>` right after
spawning it. That stops this plugin from retrying the thread and cancels any
retry it already queued; `bb provider-retry status <thread-id>` confirms it.
