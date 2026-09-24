---
artifact_type: cuj
journey: structured-child-results
actor: worker or reviewer agent (returns), coordinator agent (reads)
criticality: p1
---

# Children return capped, structured results

## Why This Journey Matters

A child's final message is the coordinator's input, and the coordinator
pays for all of it. Long narrative returns, pasted logs and repeated
context fill a coordinator's window over a multi-day project and bring
compaction or rotation sooner. A return that doesn't state its evidence
makes the coordinator check the work again. One that doesn't say what
kind of failure happened can send the coordinator after the wrong problem.

That last case is common. Build checks have failed because of the
environment (missing native modules, missing type declarations, a loaded
machine), and each cost a full rebuild cycle before the real result
arrived. A return that says "failed" without saying "environment" leads
the coordinator to debug code that isn't broken.

### Current State vs. Planned

| Capability | Status |
|---|---|
| Final output of a thread readable from the CLI | **Shipped** (upstream `bb thread output`) |
| `DONE:` / `BLOCKED:` first line, evidence, decision | **Convention** (prompt) |
| Return schema with a size cap, checked by bb | **Planned** |
| Failure classified as environment or real | **Planned** (by convention today) |
| Environment preflight before expensive verification | **Planned** |

## The Journey

A worker finishes. Its final message has a fixed shape:

- **Status:** `DONE` or `BLOCKED`.
- **Evidence:** commit SHAs, files changed, the checks run and their
  results, links to artifacts. Not pasted logs.
- **Failures:** for each failing check, whether it's *real* (the change is
  wrong) or *environment* (the machine, dependencies or load), with the
  one line that shows which.
- **Decision needed:** at most one clear question, if BLOCKED.
- **Choices to review:** a few lines at most.

*Planned:* bb checks the shape and the size cap. A return that is too
long or missing a field is sent back to the child once, instead of being
passed to the coordinator. Long evidence goes into files or artifacts that
the coordinator opens only if it needs them.

*Planned:* before a worker starts expensive verification (a full build
or test run), a cheap preflight checks the environment: native modules
present, type declarations built, machine not overloaded. If the
preflight fails, the worker reports an environment failure right away and
doesn't burn a full cycle.

The coordinator reads the return in one pass, checks the named evidence,
and decides the next step.

## Success Signals

| Signal | Type | Status | Assertion |
|---|---|---|---|
| Returns are classified | measurable | active | Final message starts with `DONE:` or `BLOCKED:` |
| Returns are capped | measurable | planned | Final messages stay within the configured size cap; oversize returns are sent back once |
| Evidence is named, not pasted | observable | active | DONE returns name SHAs, files and check results the coordinator can verify |
| Failures are classified | observable | planned | Every failing check in a return is labelled `real` or `environment` |
| Environment failures caught early | measurable | planned | Environment problems are reported by preflight, before a full build or test cycle |
| One decision per block | qualitative | active | A BLOCKED return asks exactly one question the coordinator or operator can answer |

## Known Friction Points

- **Prompt-only today.** Shape and length depend on each child following
  its instructions.
- **Classifying failures is hard.** Some failures look like environment
  problems and aren't. A wrong label wastes a cycle the other way.
- **Caps can cut useful detail.** The cap needs an escape hatch: detail
  goes into an artifact, not the message.
