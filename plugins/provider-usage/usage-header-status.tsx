import { useState, type ReactNode } from "react";
import { experimental_ProviderIcon as ProviderIcon } from "@get-bb/plugin-sdk/app";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import type { HeaderQuota } from "./usage-header.js";

const FULL_QUOTA_WIDTH_PX = 96;
const PERCENT_QUOTA_WIDTH_PX = 56;

type HeaderQuotaDetail = "full" | "percent" | "worst";

export function headerQuotaDetail(
  count: number,
  availableWidth: number,
  isCompactViewport: boolean,
): HeaderQuotaDetail {
  if (!isCompactViewport && availableWidth >= count * FULL_QUOTA_WIDTH_PX)
    return "full";
  if (availableWidth >= count * PERCENT_QUOTA_WIDTH_PX) return "percent";
  return "worst";
}

function quotaToneClass(tone: HeaderQuota["tone"]): string {
  if (tone === "critical") return "text-destructive-text";
  if (tone === "warning") return "text-warning-text";
  return "text-foreground";
}

export function ProviderUsageHeaderQuotas({
  quotas,
  availableWidth,
  isCompactViewport,
  renderPanel,
}: {
  quotas: readonly HeaderQuota[];
  availableWidth: number;
  isCompactViewport: boolean;
  renderPanel(dismiss: () => void): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (quotas.length === 0) return null;
  const detail = headerQuotaDetail(
    quotas.length,
    availableWidth,
    isCompactViewport,
  );
  const shown =
    detail === "worst"
      ? [
          quotas.reduce((worst, quota) =>
            quota.usedPercent > worst.usedPercent ? quota : worst,
          ),
        ]
      : quotas;
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={150}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          data-testid="provider-usage-header-status"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 items-center gap-3 rounded px-1.5 py-1 text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {shown.map((quota) => (
            <span
              key={quota.providerId}
              data-provider-usage-quota={quota.providerId}
              className="flex shrink-0 items-center gap-1"
            >
              <span
                role="img"
                aria-label={quota.displayName}
                title={quota.displayName}
                className="flex size-4 shrink-0 items-center justify-center"
              >
                <ProviderIcon
                  providerKind="agent"
                  provider={{ ...quota.provider, id: quota.providerId }}
                  fallback="Bot"
                  className="size-3.5"
                  aria-hidden="true"
                />
              </span>
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  quotaToneClass(quota.tone),
                )}
              >
                {Math.round(quota.usedPercent)}%
              </span>
              {detail === "full" && quota.reset !== null ? (
                <span className="tabular-nums text-subtle-foreground/75">
                  {quota.reset}
                </span>
              ) : null}
            </span>
          ))}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="end"
        collisionPadding={8}
        className="w-80 max-w-[calc(100vw-1rem)] overflow-hidden p-0"
      >
        {renderPanel(() => setOpen(false))}
      </HoverCardContent>
    </HoverCard>
  );
}
