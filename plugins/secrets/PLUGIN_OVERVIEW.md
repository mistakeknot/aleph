Give an agent the API keys it needs without pasting them into chat. The agent asks, you type the values into a masked form, and the host writes them to an allowlisted dotenv file.

## What you get

- A secure form in the thread for each requested variable, with a show or hide control per field.
- The destination, project, and a short request fingerprint shown on the form, so you can see exactly where the values will go.
- Values written by the host directly to the dotenv file, with file mode `0600`.
- Existing assignments updated in place and new ones appended. Other lines stay unchanged.
- A result for the agent that lists the path and the added, updated, and unchanged names. Values never appear in the transcript.

## How it works

The agent runs one command from inside a thread:

```
bb secret request OPENAI_API_KEY --project demo --purpose "Configure the server" --describe OPENAI_API_KEY "OpenAI key" --write-env .env.local
```

The request is checked on the host before the form opens: the project, the resolved path, and every variable name must match one entry of the host's allowlist at `/etc/home-secrets/allowlist.json`. That file must be owned by root and not writable by group or others. Agents cannot add entries; you edit it from a root shell. A request that does not match is refused with a fixed message and no form is shown.

The form shows the purpose, the destination path, and one field per name. Submit to write the file, or cancel to stop the command. Each value must be a single non-empty line of at most 16 KiB. The values go to the host in one commit step that re-checks the request, the allowlist entry, and the destination directory and file identity before and after the write. If the destination moved or was replaced while writing, the command exits 1 and says so; nothing is rolled back.

The plugin itself never reads or writes the dotenv file. The bundled `secrets` skill tells agents to batch known variables into one request and to never read the completed file back.

## Limits

- Only the destination file is protected (entry-only scope). A same-user process that swaps the destination between the final check and the rename is a known residual.
- Descriptions and purposes that look like a credential are rejected before the form opens.
- A destination with duplicate assignments, multiline quoted values, or colon-style assignments for a requested name is refused before the form opens. A value that cannot be written so that both dotenv and Node parse it back unchanged is refused at write time.

## Requirements

The command must run from a bb thread with a live host that has an allowlist entry for the project and path.
