import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useSidebarThreads,
  type ExperimentalSidebarFooterDisclosureProps,
  useBbContext,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  describeUsageBurn,
  formatUsageDuration,
  formatUsageReset,
  formatUsdCents,
  usageBarColorClass,
  usageBurnRate,
} from "./usage-format.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LIST_HOVER_TRANSITION } from "@/components/ui/motion";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
} from "@/components/ui/option-display";
import {
  providerUsageTone,
  selectUsageMachine,
  usageRpcSuccessSchema,
  type UsageMachine,
  type UsageProvider,
  type UsageSnapshot,
  type UsageWindow as UsageWindowValue,
} from "./usage-schema.js";
import {
  emptyUsageMessage,
  hasReportedUsage,
  offlineUsageMessage,
  UsageFeedback,
  usageFeedbackMessages,
} from "./usage-feedback.js";

import { UsageSettings } from "./settings.js";

export interface UsageStoreSnapshot {
  data: UsageSnapshot | null;
  error: string | null;
  isRefreshing: boolean;
}

const CARD_MAX_AGE_MS = 2 * 60_000;
const FOCUS_MAX_AGE_MS = 5 * 60_000;
const SAFETY_REFRESH_INTERVAL_MS = 30 * 60_000;
const storeListeners = new Set<() => void>();
let storeSnapshot: UsageStoreSnapshot = {
  data: null,
  error: null,
  isRefreshing: false,
};
let activeRefreshCount = 0;
let lastMachineId: string | null = null;

function updateStore(next: UsageStoreSnapshot): void {
  storeSnapshot = next;
  for (const listener of storeListeners) listener();
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

function getStoreSnapshot(): UsageStoreSnapshot {
  return storeSnapshot;
}

function rpcErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = Reflect.get(body, "error");
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return null;
  const message = Reflect.get(error, "message");
  return typeof message === "string" ? message : null;
}

function refreshUsage({
  force,
  machineIds,
  maxAgeMs,
  providerId = null,
  signal,
}: {
  force: boolean;
  machineIds: string[] | null;
  maxAgeMs: number;
  providerId?: string | null;
  signal?: AbortSignal;
}): Promise<void> {
  activeRefreshCount += 1;
  updateStore({ ...storeSnapshot, error: null, isRefreshing: true });
  return (async () => {
    try {
      const response = await fetch(
        "/api/v1/plugins/provider-usage/rpc/getUsage",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force, machineIds, maxAgeMs, providerId }),
          signal:
            signal === undefined
              ? AbortSignal.timeout(60_000)
              : AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        },
      );
      if (!response.ok)
        throw new Error(`Usage request returned HTTP ${response.status}.`);
      const body: unknown = await response.json();
      const parsed = usageRpcSuccessSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error(
          rpcErrorMessage(body) ?? "Provider usage could not be loaded.",
        );
      }
      updateStore({
        data: parsed.data.result,
        error: null,
        isRefreshing: activeRefreshCount > 1,
      });
    } catch (cause) {
      if (signal?.aborted === true) {
        return;
      }
      console.warn("Provider usage refresh failed", cause);
      updateStore({
        ...storeSnapshot,
        error: "Couldn’t refresh usage.",
      });
    } finally {
      activeRefreshCount -= 1;
      if (activeRefreshCount === 0 && storeSnapshot.isRefreshing) {
        updateStore({ ...storeSnapshot, isRefreshing: false });
      }
    }
  })();
}

async function refreshMachineUsage({
  force,
  machineId,
  maxAgeMs,
  providerIds,
}: {
  force: boolean;
  machineId: string;
  maxAgeMs: number;
  providerIds: readonly string[];
}): Promise<void> {
  activeRefreshCount += 1;
  updateStore({ ...storeSnapshot, isRefreshing: true });
  try {
    for (const providerId of providerIds) {
      await refreshUsage({
        force,
        machineIds: [machineId],
        maxAgeMs,
        providerId,
      });
    }
  } finally {
    activeRefreshCount -= 1;
    if (activeRefreshCount === 0 && storeSnapshot.isRefreshing) {
      updateStore({ ...storeSnapshot, isRefreshing: false });
    }
  }
}

function formatResetCountdown(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const remaining = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return "now";
  return formatUsageDuration(remaining);
}
function UsageWindow({
  window,
  now,
}: {
  window: UsageWindowValue;
  now: number;
}) {
  const reset = formatUsageReset(window.resetsAt);
  const countdown = formatResetCountdown(window.resetsAt);
  const burn = usageBurnRate(window, now);
  const burnSummary = burn === null ? null : describeUsageBurn(burn);
  const value =
    window.cost === null
      ? Math.round(window.usedPercent) + "% used"
      : formatUsdCents(window.cost.usedUsdCents, true) +
        " / " +
        formatUsdCents(window.cost.limitUsdCents, false);
  const [open, setOpen] = useState(false);
  const openAtPointerDown = useRef<boolean | null>(null);
  const label = window.label
    .replace(/^Five-hour limit$|^5 hours$/u, "5h")
    .replace(/^Weekly limit$|^Weekly/u, "7d")
    .replace(/^Daily limit$/u, "1d");
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        asChild
        onPointerDown={(event) => {
          openAtPointerDown.current = open;
          event.preventDefault();
        }}
        onClick={(event) => {
          event.preventDefault();
          const wasOpen = openAtPointerDown.current ?? open;
          openAtPointerDown.current = null;
          setOpen(!wasOpen);
        }}
      >
        <div
          tabIndex={0}
          role="group"
          className="col-span-full grid grid-cols-subgrid items-center rounded-sm py-0.5 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          aria-label={
            `${window.label}: ${value}. ${reset ?? "Reset time not reported"}` +
            (burnSummary === null ? "" : `. ${burnSummary}`)
          }
        >
          <span className="max-w-20 truncate text-subtle-foreground">
            {label}
          </span>
          <span className="h-1 min-w-0 overflow-hidden rounded-full bg-sidebar-border">
            <span
              className={
                "block h-full rounded-full " +
                usageBarColorClass(window.usedPercent)
              }
              style={{
                width: Math.max(2, Math.min(100, window.usedPercent)) + "%",
              }}
            />
          </span>
          <span className="text-right tabular-nums text-sidebar-foreground">
            {Math.round(window.usedPercent)}%
          </span>
          <span
            aria-hidden="true"
            className="text-right tabular-nums text-subtle-foreground"
          >
            {countdown ?? "—"}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="space-y-0.5">
        <p className="font-medium">{window.label}</p>
        <p>
          {value}
          {" · "}
          {reset ?? "Reset time not reported"}
        </p>
        {burnSummary === null ? null : <p>{burnSummary}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

function ProviderUsageBody({
  provider,
  now,
}: {
  provider: UsageProvider;
  now: number;
}) {
  const usage = provider.usage;
  if (usage === null) {
    return <p className="text-xs text-muted-foreground">Usage not reported.</p>;
  }
  switch (usage.status) {
    case "ok":
      return usage.windows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No usage limits reported for this plan.
        </p>
      ) : (
        <div className="grid grid-cols-[max-content_minmax(0,1fr)_max-content_max-content] gap-x-3 gap-y-0.5">
          {usage.windows.map((window) => (
            <UsageWindow key={window.label} window={window} now={now} />
          ))}
        </div>
      );
    case "not_installed":
      return (
        <p className="text-xs text-muted-foreground">
          Not installed on this machine.
        </p>
      );
    case "unauthenticated":
      return (
        <p className="text-xs text-muted-foreground">{provider.signInHint}</p>
      );
    case "expired":
      return (
        <p className="text-xs text-muted-foreground">{provider.expiredHint}</p>
      );
    case "error":
      return <p className="text-xs text-muted-foreground">{usage.message}</p>;
  }
}

function MachineSelector({
  machines,
  activeMachine,
  onSelect,
}: {
  machines: UsageMachine[];
  activeMachine: UsageMachine | null;
  onSelect: (machineId: string) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={machines.length === 0}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={
            activeMachine === null
              ? "Usage machine"
              : "Usage machine: " + activeMachine.displayName
          }
          disabled={machines.length === 0}
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            LIST_HOVER_TRANSITION,
            "h-7 shrink overflow-hidden px-1 text-sidebar-foreground hover:bg-sidebar-accent",
          )}
        >
          <span className="block min-w-0 flex-1 truncate">
            {activeMachine?.displayName ?? "Usage"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        mobileTitle="Usage source"
        className="max-w-72"
      >
        {machines.map((machine) => {
          const isActive = machine.id === activeMachine?.id;
          return (
            <DropdownMenuItem
              key={machine.id}
              role="menuitemradio"
              aria-label={machine.displayName}
              aria-checked={isActive}
              onSelect={() => onSelect(machine.id)}
              className="flex items-center gap-2"
            >
              <Icon
                name={machine.id.startsWith("source:") ? "Layers" : "Laptop"}
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">
                {machine.displayName}
              </span>
              <Icon
                name="Check"
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0",
                  isActive ? "opacity-100" : "opacity-0",
                )}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountUsage({
  account,
  machineError,
  now,
  snapshot,
}: {
  account: UsageProvider;
  machineError: string | null;
  now: number;
  snapshot: UsageStoreSnapshot;
}) {
  const email =
    account.usage?.status === "ok" &&
    account.usage.accountEmail !== null &&
    account.usage.accountEmail !== account.accountLabel
      ? account.usage.accountEmail
      : null;
  const planLabel =
    account.usage?.status === "ok" ? account.usage.planLabel : null;
  const AccountContainer = account.accountLabel === null ? "div" : "section";
  return (
    <AccountContainer
      aria-label={account.accountLabel ?? undefined}
      className="py-1.5 first:pt-0 last:pb-0"
    >
      {account.accountLabel === null &&
      email === null &&
      planLabel === null ? null : (
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            {account.accountLabel === null ? null : (
              <h3
                title={account.accountLabel}
                className="truncate text-xs font-medium text-sidebar-foreground"
              >
                {account.accountLabel}
              </h3>
            )}
            {email === null ? null : (
              <p
                title={email}
                className="truncate text-2xs text-subtle-foreground"
              >
                {email}
              </p>
            )}
          </div>
          {planLabel === null ? null : (
            <span className="ml-auto shrink-0 rounded-sm bg-sidebar-border/60 px-1 py-0.5 text-2xs leading-none text-subtle-foreground">
              {planLabel}
            </span>
          )}
        </div>
      )}
      <div className="mt-1">
        {account.usage === null && snapshot.isRefreshing ? (
          <p className="text-xs text-muted-foreground">
            {usageFeedbackMessages.loading}
          </p>
        ) : account.usage === null &&
          (machineError !== null || snapshot.error !== null) ? (
          <p className="text-xs text-muted-foreground">
            {usageFeedbackMessages.unavailable}
          </p>
        ) : (
          <ProviderUsageBody provider={account} now={now} />
        )}
      </div>
    </AccountContainer>
  );
}

export function ProviderUsageStatusContent({
  dismiss,
  snapshot,
  threadMachineId,
  refreshEnabled = true,
}: ExperimentalSidebarFooterDisclosureProps & {
  snapshot: UsageStoreSnapshot;
  threadMachineId: string | null;
  refreshEnabled?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const machines = snapshot.data?.machines ?? [];
  const [requestedMachineId, setRequestedMachineId] = useState<string | null>(
    lastMachineId,
  );
  const activeMachine = selectUsageMachine(
    machines,
    requestedMachineId,
    threadMachineId,
  );
  const providers = useMemo(() => {
    const groups = new Map<
      string,
      UsageProvider & { accounts: UsageProvider[] }
    >();
    for (const account of activeMachine?.providers ?? []) {
      if (account.usage?.status === "not_installed") continue;
      const group = groups.get(account.providerId);
      if (group) group.accounts.push(account);
      else
        groups.set(account.providerId, {
          ...account,
          id: account.providerId,
          accounts: [account],
        });
    }
    return [...groups.values()];
  }, [activeMachine]);
  const hasUsage = hasReportedUsage(
    providers.flatMap((provider) => provider.accounts),
  );
  const feedback =
    activeMachine === null
      ? snapshot.error !== null
        ? usageFeedbackMessages.loadFailed
        : snapshot.isRefreshing
          ? usageFeedbackMessages.loading
          : usageFeedbackMessages.noSources
      : activeMachine.status === "disconnected"
        ? offlineUsageMessage(activeMachine, hasUsage)
        : snapshot.error !== null || activeMachine.error !== null
          ? hasUsage
            ? usageFeedbackMessages.refreshFailed
            : usageFeedbackMessages.loadFailed
          : providers.length === 0
            ? emptyUsageMessage(activeMachine)
            : null;
  const activeMachineId = activeMachine?.id ?? null;
  const activeMachineConnected = activeMachine?.status === "connected";
  const providerIdsKey = providers
    .map((provider) => provider.providerId)
    .join("\n");

  useEffect(() => {
    if (!refreshEnabled) return;
    if (
      activeMachineId === null ||
      !activeMachineConnected ||
      providerIdsKey === ""
    )
      return;
    const providerIds = providerIdsKey.split("\n");
    let running = false;
    const refresh = () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      void refreshMachineUsage({
        force: false,
        machineId: activeMachineId,
        maxAgeMs: CARD_MAX_AGE_MS,
        providerIds,
      }).finally(() => {
        running = false;
      });
    };
    refresh();
    const timer = window.setInterval(refresh, CARD_MAX_AGE_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [activeMachineConnected, activeMachineId, providerIdsKey, refreshEnabled]);

  const selectMachine = useCallback((machineId: string) => {
    lastMachineId = machineId;
    setRequestedMachineId(machineId);
  }, []);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex max-h-96 flex-col">
        <div
          data-provider-usage-header=""
          className="flex h-10 min-w-0 shrink-0 items-center gap-1 border-b border-sidebar-border px-1.5"
        >
          <div className="flex min-w-0 flex-1 justify-start">
            <MachineSelector
              machines={machines}
              activeMachine={activeMachine}
              onSelect={selectMachine}
            />
          </div>
          <button
            type="button"
            aria-label="Reload provider usage"
            disabled={snapshot.isRefreshing}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50"
            onClick={() =>
              void (activeMachineId === null ||
              !activeMachineConnected ||
              providerIdsKey === ""
                ? refreshUsage({
                    force: true,
                    machineIds:
                      activeMachineId === null ? null : [activeMachineId],
                    maxAgeMs: 0,
                    providerId: null,
                  })
                : refreshMachineUsage({
                    force: true,
                    machineId: activeMachineId,
                    maxAgeMs: 0,
                    providerIds: providerIdsKey.split("\n"),
                  }))
            }
          >
            <Icon
              name="RotateCcw"
              aria-hidden="true"
              className={
                "size-3.5 " + (snapshot.isRefreshing ? "animate-spin" : "")
              }
            />
          </button>
          <button
            type="button"
            aria-label="Collapse provider usage"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            onClick={dismiss}
          >
            <Icon name="ChevronDown" aria-hidden="true" className="size-4" />
          </button>
        </div>
        <div
          aria-label={
            activeMachine === null
              ? "Provider usage"
              : activeMachine.displayName + " usage"
          }
          role="region"
          className="min-h-0 overflow-y-auto p-2.5"
        >
          {feedback === null ? null : (
            <UsageFeedback
              message={feedback}
              loading={feedback === usageFeedbackMessages.loading}
              className={providers.length > 0 ? "mb-2" : undefined}
            />
          )}
          <div className="divide-y divide-sidebar-border">
            {providers.map((provider) => {
              const tones = provider.accounts.map(providerUsageTone);
              const tone = tones.includes("critical")
                ? "critical"
                : tones.includes("warning")
                  ? "warning"
                  : null;
              return (
                <section
                  key={provider.id}
                  aria-label={provider.displayName}
                  data-provider-usage-provider={provider.id}
                  className="py-2 first:pt-0 last:pb-0"
                >
                  <h2
                    title={
                      tone === null
                        ? provider.displayName
                        : `${provider.displayName}: an account usage window is at least ${tone === "critical" ? "95" : "80"}% used.`
                    }
                    className="mb-1 flex min-w-0 items-center gap-1.5 text-xs font-medium text-sidebar-foreground"
                  >
                    <span className="relative flex size-4 shrink-0 items-center justify-center">
                      <ProviderIcon
                        providerKind="agent"
                        provider={provider}
                        fallback="Bot"
                        className="size-3.5"
                      />
                      {tone === null ? null : (
                        <span
                          aria-hidden="true"
                          data-provider-usage-tone={tone}
                          className={cn(
                            "absolute -right-0.5 -top-0.5 size-1.5 rounded-full ring-2 ring-sidebar-accent",
                            tone === "critical"
                              ? "bg-destructive"
                              : "bg-warning",
                          )}
                        />
                      )}
                    </span>
                    <span className="truncate">{provider.displayName}</span>
                  </h2>
                  <div className="divide-y divide-sidebar-border/60">
                    {provider.accounts.map((account) => (
                      <AccountUsage
                        key={account.id}
                        account={account}
                        machineError={activeMachine?.error ?? null}
                        now={now}
                        snapshot={snapshot}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function ProviderUsageStatus(props: ExperimentalSidebarFooterDisclosureProps) {
  const snapshot = useSyncExternalStore(
    subscribeStore,
    getStoreSnapshot,
    getStoreSnapshot,
  );
  const { threadId } = useBbContext();
  const sidebarThreads = experimental_useSidebarThreads();
  const threadMachineId = useMemo(
    () =>
      sidebarThreads.threads.find((thread) => thread.id === threadId)?.host
        ?.id ?? null,
    [sidebarThreads.threads, threadId],
  );
  return (
    <ProviderUsageStatusContent
      {...props}
      snapshot={snapshot}
      threadMachineId={threadMachineId}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "usage", component: UsageSettings });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "usage",
    label: "Provider usage",
    icon: "ChartColumn",
    component: ProviderUsageStatus,
  });
  app.contentScripts.register({
    id: "refresh-usage",
    mount({ signal }) {
      let timer: number | null = null;
      let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
      let blurredAt: number | null = null;
      const scheduleSafetyRefresh = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        if (signal.aborted || document.visibilityState !== "visible") return;
        timer = window.setTimeout(runSafetyRefresh, SAFETY_REFRESH_INTERVAL_MS);
      };
      const reconcile = (maxAgeMs: number, machineIds: string[] | null) => {
        void refreshUsage({
          force: false,
          machineIds,
          maxAgeMs,
          signal,
        });
      };
      const runSafetyRefresh = () => {
        if (document.visibilityState === "visible") {
          reconcile(SAFETY_REFRESH_INTERVAL_MS, null);
        }
        scheduleSafetyRefresh();
      };
      const onActive = () => {
        const inactiveAt =
          hiddenAt === null
            ? blurredAt
            : blurredAt === null
              ? hiddenAt
              : Math.min(hiddenAt, blurredAt);
        hiddenAt = null;
        blurredAt = null;
        if (
          inactiveAt !== null &&
          Date.now() - inactiveAt >= FOCUS_MAX_AGE_MS
        ) {
          reconcile(FOCUS_MAX_AGE_MS, null);
        }
        scheduleSafetyRefresh();
      };
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          hiddenAt ??= Date.now();
          if (timer !== null) window.clearTimeout(timer);
          timer = null;
          return;
        }
        onActive();
      };
      const onBlur = () => {
        blurredAt ??= Date.now();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("blur", onBlur);
      window.addEventListener("focus", onActive);
      reconcile(SAFETY_REFRESH_INTERVAL_MS, null);
      scheduleSafetyRefresh();
      return () => {
        if (timer !== null) window.clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("focus", onActive);
      };
    },
  });
});
