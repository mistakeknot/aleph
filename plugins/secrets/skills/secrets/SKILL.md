---
name: secrets
description: "Request user-supplied credentials securely into a dotenv file without exposing their values to the agent."
---

# Request secrets securely

Use `bb secret request` when the user needs to supply a credential. Do not ask the user to paste a secret into chat.

Batch every currently known variable into one request. Inspect documentation or `.env.example` to identify variable names, but do not read or print an existing secret-bearing env file.

```bash
bb secret request OPENAI_API_KEY RESEND_API_KEY \
  --project demo \
  --purpose "Configure application credentials" \
  --describe OPENAI_API_KEY "OpenAI API key used by the server" \
  --describe RESEND_API_KEY "Resend API key used for transactional email" \
  --write-env .env.local
```

Always provide `--project`, the exact `--write-env` destination, a concise purpose, and one short plain-language description per variable. The project, the resolved path, and the names must match an entry on the host's allowlist; you cannot add entries, and an unlisted request is refused before any form opens. If it is refused, tell the user what was refused and that the allowlist entry is theirs to add. Do not retry with a different path to get around it. Relative destinations resolve from the CLI working directory; paths must be normalized (no `.`, `..`, empty segments, or trailing slash). Never place secret values in argv, prompts, comments, logs, or follow-up messages. Descriptions and purposes that look like a credential are rejected.

After success, trust the command's path and added/updated/unchanged counts. Never verify by running `cat`, `sed`, `env`, or another command that would reveal the completed file.

If the command exits 1 reporting that the destination was moved or replaced, the values may not be at the requested path; tell the user rather than rerunning blindly. If it reports duplicate dotenv assignments, fix the file structure without reading values and rerun the request. If the request expired or was cancelled, rerun it only if the user still wants it; do not ask the user to paste values. Under the workspace sandbox (Accept Edits / Approve for me), Claude's macOS sandbox permits the loopback access plugin CLI commands need; Linux and other provider sandboxes may still require escalation approval.
