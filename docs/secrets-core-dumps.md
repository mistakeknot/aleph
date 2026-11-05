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

- `core(5)`: the core size limit (`RLIMIT_CORE`) is ignored when
  `kernel.core_pattern` pipes the dump to a handler. Here the pattern pipes to
  `apport`, so a soft limit of 0 does not by itself show that a crash cannot
  write a memory image. Whether `apport` honors the limit for these processes
  is unverified; treat the zero limit as unproven protection, not an assurance.
- Typed values sit in server memory between the form and the host commit. If a
  crash report is collected, the report may hold them. A `.crash` report for a
  node process exists in `/var/crash`; its contents were not read.
- Raising `LimitCORE` for the bb server or host daemon would make this worse
  and should not be done.

Not changed by this branch. Recommended follow-up for the host owner: confirm
how `apport` treats bb server and host-daemon crashes (for example by
disabling collection for those units), and keep `/var/crash` out of any
backup. Setting `LimitCORE=0` alone is not a sufficient control while the core
pattern is piped.
