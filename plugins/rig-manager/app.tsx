import { useState, useSyncExternalStore } from "react";
import { definePluginApp, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { rigRpcContract } from "./contract.js";
import type { Result } from "@bb/rig";

type Action = "export" | "apply";
let action: Action | null = null;
const listeners = new Set<() => void>();
function setAction(next: Action | null) {
  action = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const policy =
  "Unknown scalar settings are omitted with opaque warnings. Named env: and store: references never resolve here and remain inactive. An export is not a share-safe artifact.";
function useContext() {
  const { values } = useSettings();
  const text = (key: string) =>
    typeof values?.[key] === "string" ? values[key] : "";
  return {
    file: text("rigPath"),
    target: text("targetPath"),
    agentHome: text("agentHome"),
    sourceRoot: text("sourceRoot"),
    builtinRoot: text("builtinRoot"),
  };
}
function RigResult({ result }: { result: Result }) {
  return (
    <div className="space-y-3">
      <ul>
        {result.changes.map((change, index) => (
          <li key={index} className="font-mono text-xs">
            {change.section} {change.kind} {change.entry}
          </li>
        ))}
      </ul>
      {!result.changes.length && (
        <p>
          No planned changes. Check unsupported entries before interpreting this
          as equality.
        </p>
      )}
      <ul aria-label="Unsupported entries">
        {result.unsupported.map((message, index) => (
          <li key={index}>{message}</li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{policy}</p>
    </div>
  );
}
export function RigSettings() {
  const rpc = useRpc<typeof rigRpcContract>();
  const context = useContext();
  const [result, setResult] = useState<Result | null>(null),
    [resultContext, setResultContext] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3 text-sm">
      <p>
        Aleph only. Stock packaging is not built yet. Paths above refer to the
        server host.
      </p>
      <p>{policy}</p>
      <Button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setResult(null);
          setError("");
          setResultContext(JSON.stringify(context));
          void rpc
            .call("diff", context)
            .then(setResult, () =>
              setError("Rig diff refused or failed; values suppressed."),
            )
            .finally(() => setBusy(false));
        }}
      >
        Diff
      </Button>
      {error && <p role="alert">{error}</p>}
      {result && resultContext === JSON.stringify(context) && (
        <RigResult result={result} />
      )}
      <p>
        Use Rig: Export or Rig: Apply in the command palette, or bb rig in the
        terminal. Apply requires a separate fresh, stopped target.
      </p>
    </div>
  );
}
function RigCommand({ kind }: { kind: Action }) {
  const rpc = useRpc<typeof rigRpcContract>();
  const saved = useContext();
  const [context, setContext] = useState(saved),
    [output, setOutput] = useState(""),
    [token, setToken] = useState(""),
    [result, setResult] = useState<Result | null>(null),
    [notices, setNotices] = useState<string[]>([]),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    setStatus("");
    try {
      if (kind === "export") {
        const exported = await rpc.call("export", { ...context, output });
        setNotices(exported.notices);
        setStatus("Exported. Review warnings before sharing.");
      } else {
        const plan = await rpc.call("plan", context);
        setResult(plan);
        setToken(plan.confirmation);
        setStatus(
          "Dry run complete. No writes. Review unsupported entries before confirming.",
        );
      }
    } catch {
      setToken("");
      setStatus("Rig operation refused or failed; values suppressed.");
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    const confirmation = token;
    setToken("");
    try {
      setResult(await rpc.call("apply", { ...context, confirmation }));
      setStatus(
        "Apply returned. Unsupported entries can remain inactive or cause all writes to be skipped; review the result.",
      );
    } catch {
      setStatus(
        "Apply refused or failed; values suppressed. Run dry run again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 text-sm">
      <p>Aleph only. All paths are absolute paths on the server host.</p>
      {(Object.keys(context) as (keyof typeof context)[]).map((key) => (
        <label key={key} className="block">
          {
            {
              file: "Rig file",
              target: "Target data directory",
              agentHome: "Provider home",
              sourceRoot: "Source root (optional)",
              builtinRoot: "Builtin root (optional)",
            }[key]
          }
          <Input
            value={context[key]}
            disabled={busy}
            onChange={(e) => {
              setContext({ ...context, [key]: e.target.value });
              setToken("");
              setResult(null);
            }}
          />
        </label>
      ))}
      {kind === "export" && (
        <label className="block">
          New export output path
          <Input value={output} onChange={(e) => setOutput(e.target.value)} />
        </label>
      )}
      <p>{policy}</p>
      <Button disabled={busy} onClick={() => void run()}>
        {kind === "export" ? "Export to new file" : "Dry run"}
      </Button>
      {result && <RigResult result={result} />}
      <ul>
        {notices.map((notice, index) => (
          <li key={index}>{notice}</li>
        ))}
      </ul>
      {token && (
        <div className="space-y-2">
          <p>
            Confirm writes to {context.target}, a fresh stopped installation.
            Provider homes must remain inside it. Files are outside the database
            transaction; there is no rollback command.
          </p>
          <Button disabled={busy} onClick={() => void confirm()}>
            Confirm apply to this target
          </Button>
        </div>
      )}
      <p role="status">{status}</p>
    </div>
  );
}
function CommandOverlay() {
  const selected = useSyncExternalStore(subscribe, () => action);
  return (
    <Dialog
      open={selected !== null}
      onOpenChange={(open) => {
        if (!open) setAction(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Rig: {selected === "export" ? "Export" : "Apply"}
          </DialogTitle>
        </DialogHeader>
        {selected && <RigCommand key={selected} kind={selected} />}
      </DialogContent>
    </Dialog>
  );
}
export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "rig",
    title: "Rig inspection",
    component: RigSettings,
  });
  for (const kind of ["export", "apply"] as const)
    app.commands.register({
      id: kind,
      title: `Rig: ${kind === "export" ? "Export" : "Apply"}`,
      run: () => setAction(kind),
    });
  app.slots.experimental_appOverlay({
    id: "rig-command",
    component: CommandOverlay,
  });
});
