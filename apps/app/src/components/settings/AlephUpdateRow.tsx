import type { ReactNode } from "react";
import type {
  SystemAlephRecoverRequest,
  SystemAlephRollbackRequest,
  SystemAlephUpdateStatus,
} from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { BbLogo } from "@/components/ui/bb-logo";
import { useAlephUpdateStatus } from "@/hooks/queries/aleph-update-queries";
import {
  useAlephUpdateRequest,
  type AlephRequestState,
} from "@/hooks/useAlephUpdateRequest";
import {
  alephCapabilityText,
  alephRunText,
  alephSelectionText,
} from "./aleph-update-presentation";

type AlephUpdateAction = Omit<
  Parameters<AlephRequestState["submit"]>[1],
  "nonce"
>;

export type AlephRequestView = Pick<
  AlephRequestState,
  "failure" | "finished" | "pending" | "runState" | "unknownMessage"
>;

interface AlephUpdateRowViewProps {
  name: string;
  status: SystemAlephUpdateStatus;
  request: AlephRequestView;
  onUpdate(body: AlephUpdateAction): void;
  onRollback(body: Omit<SystemAlephRollbackRequest, "nonce">): void;
  onRecover(body: Omit<SystemAlephRecoverRequest, "nonce">): void;
  onDismiss(): void;
}

function threadsText(count: number): string {
  return `${String(count)} thread${count === 1 ? " is" : "s are"} running; updating interrupts ${count === 1 ? "it" : "them"}`;
}

function ActionButton({
  children,
  disabled = false,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      className="h-6 shrink-0 gap-1.5 px-2 text-xs"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function AlephUpdateRowView({
  name,
  status,
  request,
  onUpdate,
  onRollback,
  onRecover,
  onDismiss,
}: AlephUpdateRowViewProps) {
  const selection = alephSelectionText(status.selection);
  const busy = request.pending !== null;
  const canAct = status.capability !== "absent" && !busy;
  const startable = status.capability === "startable";
  const interrupt = status.activeThreadCount > 0;
  const target = status.target;
  const installed = status.installed;
  const predecessor = status.predecessor;
  const updateLabel = !startable
    ? "Show command"
    : interrupt
      ? "Update and interrupt"
      : "Update";
  const showUpdate =
    canAct && status.selection === "available" && target !== null;
  const showRecover = canAct && status.selection === "recovery-required";
  const showRollback =
    canAct &&
    predecessor !== null &&
    installed !== null &&
    status.selection !== "recovering" &&
    status.selection !== "recovery-required";
  const progress =
    request.pending === null
      ? null
      : alephRunText(request.runState ?? "not-found");
  const finishedText =
    request.finished === null ? null : alephRunText(request.finished.state);
  const dismissible =
    request.unknownMessage !== null ||
    request.finished !== null ||
    request.failure !== null;

  return (
    <div className="min-w-0" data-bb-update-role="aleph">
      <div
        className={cn(
          "grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 py-2 text-sm first:pt-0 last:pb-0",
        )}
      >
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center"
        >
          <BbLogo className="size-4" />
        </span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">
            {name}
          </span>
          {installed === null ? null : (
            <span className="min-w-0 shrink text-2xs text-muted-foreground">
              {installed.aleph}
              {target !== null && target.aleph !== installed.aleph ? (
                <>
                  <span className="px-1">→</span>
                  <span className="font-semibold text-version-upgrade">
                    {target.aleph}
                  </span>
                </>
              ) : null}
            </span>
          )}
          <span
            className={cn(
              "shrink-0 text-xs font-semibold",
              selection.tone === "error"
                ? "text-destructive"
                : "text-subtle-foreground",
            )}
          >
            {selection.label}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center justify-end gap-1">
          {busy ? (
            <Icon aria-hidden name="Loading" className="size-3 animate-spin" />
          ) : null}
          {showUpdate && target !== null ? (
            <ActionButton
              onClick={() =>
                onUpdate({
                  confirm: "update",
                  interrupt,
                  manifestDigest: target.manifestDigest,
                  target: target.aleph,
                })
              }
            >
              {updateLabel}
            </ActionButton>
          ) : null}
          {showRecover ? (
            <ActionButton onClick={() => onRecover({ confirm: "recover" })}>
              Recover
            </ActionButton>
          ) : null}
          {showRollback && predecessor !== null && installed !== null ? (
            <ActionButton
              onClick={() =>
                onRollback({
                  confirm: "rollback",
                  from: installed.aleph,
                  interrupt,
                  to: predecessor.aleph,
                })
              }
            >
              Roll back to {predecessor.aleph}
            </ActionButton>
          ) : null}
          {dismissible ? (
            <ActionButton onClick={onDismiss}>Dismiss</ActionButton>
          ) : null}
        </span>
      </div>
      <div className="flex flex-col gap-1 pb-2 pl-9 text-xs text-muted-foreground">
        <span>{alephCapabilityText(status.capability)}</span>
        {status.detail === null ? null : <span>{status.detail}</span>}
        {interrupt && (showUpdate || showRollback) ? (
          <span>{threadsText(status.activeThreadCount)}</span>
        ) : null}
        {progress === null ? null : <span>{progress}</span>}
        {finishedText === null ? null : <span>{finishedText}</span>}
        {request.unknownMessage === null ? null : (
          <span className="font-semibold text-destructive">
            {request.unknownMessage}
          </span>
        )}
        {request.failure === null ? null : (
          <>
            <span className="font-semibold text-destructive">
              {request.failure.message}
            </span>
            {request.failure.command === null ? null : (
              <code className="select-all rounded bg-muted px-1.5 py-0.5 font-mono">
                {request.failure.command}
              </code>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function AlephUpdateRow({
  name,
  status,
}: {
  name: string;
  status: SystemAlephUpdateStatus;
}) {
  const request = useAlephUpdateRequest();
  return (
    <AlephUpdateRowView
      name={name}
      status={status}
      request={request}
      onUpdate={(body) => request.submit("update", body)}
      onRollback={(body) => request.submit("rollback", body)}
      onRecover={(body) => request.submit("recover", body)}
      onDismiss={request.dismiss}
    />
  );
}

export function useAlephUpdateRowStatus(enabled: boolean) {
  const query = useAlephUpdateStatus({ enabled });
  return enabled ? (query.data ?? null) : null;
}
