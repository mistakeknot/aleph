# Secrets: core dump settings (T1.9)

Observed on the dev host on 2026-11-04, read from `/proc` and `sysctl` files only. No
environment or credential file was read. This is a record, not a fix.

| Setting                                                                            | Observed                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Soft core limit of the bb app processes (`/proc/PID/limits`, `Max core file size`) | 0 (hard limit unlimited)                                                                          |
| Soft core limit of the interactive agent shell                                     | 0                                                                                                 |
| `kernel.core_pattern`                                                              | pipes to `apport`                                                                                 |
| `fs.suid_dumpable`                                                                 | 2                                                                                                 |
| `apport` service                                                                   | active                                                                                            |
| `/var/crash`                                                                       | world-writable, group `whoopsie`, setgid, sticky; holds `.crash` reports for other node processes |

What this means for secret values:

- With a soft limit of 0 the kernel writes no core file for the bb processes
  as they run today, so a crash does not dump the plugin's memory.
- The limit is soft. A process, or a unit that raises it, can turn dumps on,
  and `apport` would then keep the memory image in `/var/crash`. Any change
  that raises `LimitCORE` for the bb server or host daemon puts typed values
  (which sit in server memory between the form and the host commit) in a
  readable crash report.
- Whether `apport` collects crash reports of node processes that exit on an
  uncaught exception regardless of the core limit is unverified. A `.crash`
  report for a node process exists in `/var/crash`; its contents were not read.

Not changed by this branch. Recommended follow-up for the host owner:
set `LimitCORE=0` on the bb server and host-daemon units so the soft limit
cannot be raised by accident, and keep `/var/crash` out of any backup.
