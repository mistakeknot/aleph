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
  useAlephInstallRequest,
  type AlephInstallRequestState,
} from "@/hooks/useAlephInstallRequest";
import {
  useAlephUpdateRequest,
  type AlephRequestState,
} from "@/hooks/useAlephUpdateRequest";
import {
  ALEPH_WRAPPER_LABEL,
  ALEPH_WRAPPER_NOTE,
  alephCapabilityText,
  alephInstallRequestLabel,
  alephInstallRequestText,
  alephRequestButton,
  alephRunText,
  alephSelectionText,
  isAlephWrapperManaged,
} from "./aleph-update-presentation";

type AlephUpdateAction = Omit<
  Parameters<AlephRequestState["submit"]>[1],
  "nonce"
>;

export type AlephRequestView = Pick<
  AlephRequestState,
  "failure" | "finished" | "pending" | "runState" | "unknownMessage"
>;

export type AlephInstallView = Pick<
  AlephInstallRequestState,
  "error" | "pending"
>;

const NO_INSTALL_ACTIVITY: AlephInstallView = { error: null, pending: false };

interface AlephUpdateRowViewProps {
  name: string;
  status: SystemAlephUpdateStatus;
  request: AlephRequestView;
  install?: AlephInstallView;
  onRequestInstall?(
    target: NonNullable<SystemAlephUpdateStatus["target"]>,
  ): void;
  onCancelInstall?(nonce: string): void;
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
  title,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title?: string | undefined;
}) {
  return (
    <span title={title} className="inline-flex shrink-0">
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
    </span>
  );
}

export function AlephUpdateRowView({
  name,
  status,
  request,
  install = NO_INSTALL_ACTIVITY,
  onRequestInstall = () => {},
  onCancelInstall = () => {},
  onUpdate,
  onRollback,
  onRecover,
  onDismiss,
}: AlephUpdateRowViewProps) {
  const wrapperManaged = isAlephWrapperManaged(status);
  const recovering =
    status.selection === "recovering" ||
    status.selection === "recovery-required";
  const selection =
    (recovering ? null : alephInstallRequestLabel(status.installRequest)) ??
    (wrapperManaged
      ? { label: ALEPH_WRAPPER_LABEL, tone: "neutral" as const }
      : alephSelectionText(status.selection));
  const busy = request.pending !== null;
  const requestButton = alephRequestButton(status);
  const installRequest = status.installRequest;
  const installText = alephInstallRequestText(installRequest);
  const installOpen = installRequest.state === "requested";
  const installTerminal = installText !== null && !installOpen;
  const canAct =
    status.capability !== "absent" &&
    status.capability !== "request-only" &&
    !busy;
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
          {requestButton.kind === "request" ? (
            <ActionButton
              disabled={requestButton.disabled || install.pending || busy}
              title={requestButton.reason ?? undefined}
              onClick={() => {
                if (status.target !== null) onRequestInstall(status.target);
              }}
            >
              {requestButton.label}
            </ActionButton>
          ) : null}
          {installOpen && installRequest.nonce !== null ? (
            <ActionButton
              disabled={install.pending}
              onClick={() => onCancelInstall(installRequest.nonce ?? "")}
            >
              Cancel request
            </ActionButton>
          ) : null}
          {installTerminal && installRequest.nonce !== null ? (
            <ActionButton
              disabled={install.pending}
              onClick={() => onCancelInstall(installRequest.nonce ?? "")}
            >
              Dismiss
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
        {wrapperManaged ? (
          <span>{ALEPH_WRAPPER_NOTE}</span>
        ) : (
          <>
            <span>{alephCapabilityText(status.capability)}</span>
            {status.detail === null ? null : <span>{status.detail}</span>}
          </>
        )}
        {interrupt && (showUpdate || showRollback) ? (
          <span>{threadsText(status.activeThreadCount)}</span>
        ) : null}
        {requestButton.kind === "request" && requestButton.reason !== null ? (
          <span>{requestButton.reason}</span>
        ) : null}
        {installText === null ? null : <span>{installText}</span>}
        {status.lastRun === null ? null : (
          <span>Last install run: {alephRunText(status.lastRun.state)}</span>
        )}
        {install.error === null ? null : (
          <span className="font-semibold text-destructive">
            {install.error}
          </span>
        )}
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
  const install = useAlephInstallRequest();
  return (
    <AlephUpdateRowView
      name={name}
      status={status}
      request={request}
      install={install}
      onRequestInstall={install.request}
      onCancelInstall={install.cancel}
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
