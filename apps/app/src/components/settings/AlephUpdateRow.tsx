import { alephInstallEligibility } from "@bb/server-contract";
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
        className="min-h-11 sm:min-h-8 shrink-0 gap-1.5 px-2 text-xs"
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
  const wrapperManaged =
    status.overview === undefined && isAlephWrapperManaged(status);
  const recovering =
    status.selection === "recovering" ||
    status.selection === "recovery-required";
  const selection =
    (recovering ? null : alephInstallRequestLabel(status.installRequest)) ??
    (wrapperManaged
      ? { label: ALEPH_WRAPPER_LABEL, tone: "neutral" as const }
      : status.overview &&
          status.selection === "manifest-missing" &&
          (status.detail === null ||
            status.detail === "No update manifest has been published.")
        ? {
            label: "Automatic update feed not configured",
            tone: "neutral" as const,
          }
        : alephSelectionText(status.selection));
  const busy = request.pending !== null;
  const candidate = alephRequestButton(status);
  const eligibility = alephInstallEligibility(status);
  const requestButton =
    eligibility.eligible && status.installRequest.state !== "requested"
      ? candidate
      : { kind: "hidden" as const };
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
          "grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] sm:grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3.5 text-sm [overflow-wrap:anywhere]",
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
          {status.overview || installed !== null ? (
            <span className="min-w-0 shrink text-2xs text-muted-foreground">
              {status.overview?.runningVersion ?? installed?.version}
              {target !== null && target.aleph !== installed?.aleph ? (
                <>
                  <span className="px-1">→</span>
                  <span className="font-semibold text-version-upgrade">
                    {target.aleph}
                  </span>
                </>
              ) : null}
            </span>
          ) : (
            <span>Version unavailable</span>
          )}
          <span
            className={cn(
              "min-w-0 text-xs font-medium",
              selection.tone === "error"
                ? "text-destructive"
                : "text-subtle-foreground",
            )}
          >
            {selection.label}
          </span>
        </span>
        <span className="col-start-2 flex flex-col items-start gap-2 sm:col-start-auto">
          {requestButton.kind === "request" ? (
            <span className="max-w-64 text-xs text-muted-foreground">
              Records a request for your Aleph operator; does not start an
              installation.
            </span>
          ) : null}
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
              Request server update
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
      <div className="flex flex-col gap-2 px-4 pb-3.5 sm:pl-13 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {!eligibility.eligible &&
        status.selection === "available" &&
        status.installRequest.state !== "requested" ? (
          <span>{eligibility.message}</span>
        ) : null}
        {status.overview?.requestRecipientConfigured !== true ? (
          <span>
            Request delivery is unavailable. An operator notification recipient
            must be configured before requesting an update.
          </span>
        ) : null}

        {installRequest.requestedAt ? (
          <span>
            Requested {new Date(installRequest.requestedAt).toLocaleString()} ·{" "}
            {status.overview?.requestDelivery === "sent"
              ? "Operator notification sent"
              : status.overview?.requestDelivery === "failed"
                ? "Operator notification failed"
                : "Notification delivery outcome unavailable"}
          </span>
        ) : null}
        {wrapperManaged ? (
          <span>Automatic update feed not configured</span>
        ) : null}
        {wrapperManaged ? (
          <span>{ALEPH_WRAPPER_NOTE}</span>
        ) : (
          <>
            <span>
              {status.selection === "manifest-missing" && status.overview
                ? "Updates are installed by your Aleph operator."
                : alephCapabilityText(status.capability)}
            </span>
            {status.detail === null ||
            (status.overview &&
              status.detail ===
                "No update manifest has been published.") ? null : (
              <span>{status.detail}</span>
            )}
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
  if (!enabled || !query.data) return null;
  if (query.isError && query.data.overview) {
    return { ...query.data, overview: { ...query.data.overview, stale: true } };
  }
  return query.data;
}
