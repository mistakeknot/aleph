import type { ReactNode } from "react";
import type { AlephOverview } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { BbLogo } from "@/components/ui/bb-logo";

function checked(source: { source: string; checkedAt: string }) {
  return `${source.source} · Last checked ${new Date(source.checkedAt).toLocaleString()}`;
}

export function AlephOverviewView({
  desktopVersion,
  runningVersion,
  overview,
  server,
  onRefresh,
  refreshing,
}: {
  desktopVersion: string | null;
  runningVersion: string | null;
  overview: AlephOverview | undefined;
  server: ReactNode;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const different =
    desktopVersion !== null &&
    runningVersion !== null &&
    desktopVersion !== runningVersion;
  const qualification = overview?.qualification;
  const installation = overview?.installation;
  const upstream = overview?.upstream;
  const sync = overview?.sync;
  const summary = overview?.summary;
  return (
    <div className="space-y-6 min-w-0 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">Updates</h2>
          <p className="text-sm text-muted-foreground">
            Your Aleph installation and what’s coming next.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-8"
          disabled={refreshing}
          onClick={onRefresh}
        >
          {refreshing ? "Refreshing…" : "Refresh status"}
        </Button>
      </div>
      {different ? (
        <div
          role="status"
          className="rounded-lg border border-border px-4 py-3 text-sm"
        >
          <strong className="font-medium">
            Your desktop and server run different versions
          </strong>
          <p className="text-muted-foreground">
            Desktop {desktopVersion} · Server {runningVersion}. Desktop
            self-update is not available yet.
          </p>
        </div>
      ) : null}
      {overview?.stale ? (
        <p role="status" className="text-sm text-muted-foreground">
          Status may be out of date or could not be refreshed.
        </p>
      ) : null}
      <section aria-label="Your Aleph" className="space-y-2">
        <h3 className="text-sm font-medium">Your Aleph</h3>
        <div className="rounded-lg border border-border divide-y divide-border">
          {desktopVersion === null ? null : (
            <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-3 px-4 py-3.5">
              <BbLogo aria-hidden className="size-4 mt-1" />
              <div className="min-w-0 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <strong className="font-medium">Desktop</strong>
                  <span className="font-mono text-xs">{desktopVersion}</span>
                </div>
                <p className="text-muted-foreground">
                  This device · Self-update not available yet
                </p>
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer min-h-11 sm:min-h-8 content-center">
                    Update options
                  </summary>
                  <p className="text-muted-foreground">
                    Desktop updates are being built separately. No desktop
                    download is available here.
                  </p>
                </details>
              </div>
            </div>
          )}
          {server}
          <div className="px-4 py-3 text-xs text-muted-foreground space-y-2">
            <p>
              {installation?.installedAt
                ? `Installed ${new Date(installation.installedAt).toLocaleString()}`
                : "Install time not recorded"}
            </p>
            {installation && installation.version !== runningVersion ? (
              <p>
                Installation record {installation.version} differs from the
                running server.
              </p>
            ) : null}
            <p>
              {qualification
                ? `Qualification ${qualification.result} for ${qualification.version} · ${qualification.commit.slice(0, 8)}`
                : "Qualification status unavailable"}
            </p>
            {qualification ? <p>{checked(qualification)}</p> : null}
            <details>
              <summary className="cursor-pointer min-h-11 sm:min-h-8 content-center">
                Release details
              </summary>
              <div className="space-y-2 py-2">
                {installation ? (
                  <p>
                    Installation provenance: {checked(installation)} ·{" "}
                    {installation.commit}
                  </p>
                ) : (
                  <p>Installation provenance unavailable.</p>
                )}
                <p>
                  {summary &&
                  summary.version === runningVersion &&
                  installation?.commit === summary.commit &&
                  installation.version === runningVersion
                    ? `Aleph release summary: ${summary.text}`
                    : "No Aleph release summary is connected for this build."}
                </p>
                <p>
                  A qualified build is separate from a published update.
                  Qualification evidence does not start or authorize an
                  installation.
                </p>
              </div>
            </details>
          </div>
        </div>
      </section>
      <section aria-label="Upstream bb" className="space-y-2">
        <h3 className="text-sm font-medium">Upstream bb</h3>
        <div className="rounded-lg border border-border px-4 py-3.5 text-sm space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <strong className="font-medium">Latest release</strong>
            <span className="font-mono text-xs">
              {upstream?.release ?? "Upstream release unavailable"}
            </span>
          </div>
          <p>
            {upstream
              ? `Upstream main is ${upstream.firstParentGap} first-parent commits ahead of Aleph’s included upstream base.`
              : "Commit gap unavailable"}
          </p>
          <p>
            {sync ? `Sync status: ${sync.phase}` : "Sync status unavailable"}
          </p>
          <p className="text-xs text-muted-foreground">
            {upstream ? checked(upstream) : "Last checked: unavailable"}
          </p>
          {sync ? (
            <p className="text-xs text-muted-foreground">{checked(sync)}</p>
          ) : null}
          <details className="text-xs">
            <summary className="cursor-pointer min-h-11 sm:min-h-8 content-center">
              Upstream changes and sync
            </summary>
            <div className="space-y-2 py-2 text-muted-foreground">
              <p>
                New upstream changes become available after Aleph integration,
                qualification and release approval.
              </p>
              {upstream ? (
                <p>
                  Included upstream base: {upstream.base}
                  <br />
                  Sampled upstream head: {upstream.head}
                </p>
              ) : (
                <p>Upstream provenance unavailable.</p>
              )}
              <a
                className="underline underline-offset-4"
                href="https://getbb.app/changelog"
                target="_blank"
                rel="noreferrer"
              >
                Upstream bb release notes
              </a>
            </div>
          </details>
        </div>
      </section>
    </div>
  );
}
