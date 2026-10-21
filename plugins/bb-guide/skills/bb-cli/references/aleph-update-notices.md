# Aleph update notices

`ALEPH_UPDATE_NOTIFY_COMMAND` names the command an Aleph server runs to tell
you about each update request. Set it to a JSON array of strings with no empty
element, for example `["/usr/local/bin/notify-admin"]`. The server runs that
argv without a shell, writes one line of at most 512 bytes to its stdin
(`Aleph install requested for <target>`, at most once per release in 24
hours), discards its output, and kills it
after five seconds. The command sees only `PATH`, `HOME`, and `LANG` from the
server's environment. When the variable is unset, empty, not valid JSON, or not
a non-empty array of non-empty strings, notices are disabled and nothing is sent
or logged.
