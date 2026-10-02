type ReleaseMeta = {
  date: string;
  headline: string;
};

export const RELEASE_META: Record<string, ReleaseMeta> = {
  "0.44.0+aleph.0.5.2": {
    date: "October 1, 2026",
    headline:
      "Aleph 0.5.2: busy threads no longer stall the server, and task comments post at once",
  },
  "0.44.0+aleph.0.5.1": {
    date: "September 29, 2026",
    headline:
      "Aleph 0.5.1: the composer no longer gets stuck after a reconnect",
  },
  "0.44.0+aleph.0.5.0": {
    date: "September 28, 2026",
    headline:
      "Aleph 0.5.0: synced to upstream bb 0.44.0, task details beside the list, account usage in the header, and Cmd-W closes the focused pane",
  },
  "0.43.4+aleph.0.4.1": {
    date: "September 27, 2026",
    headline:
      "Aleph 0.4.1: a new app icon, and provider usage on hover with burn rates inline",
  },
  "0.44.0": {
    date: "September 25, 2026",
    headline: "Diff filtering, safer archiving, and plugin safe mode",
  },
  "0.43.4+aleph.4": {
    date: "September 27, 2026",
    headline: "Aleph: Cmd+K quick switcher and every provider's usage at once",
  },
  "0.43.4+aleph.3": {
    date: "September 25, 2026",
    headline:
      "Aleph: the desktop app is named Aleph, event-backed thread waits",
  },
  "0.43.4+aleph.2": {
    date: "September 24, 2026",
    headline: "Aleph: quieter parent wakes and Thecla as the default theme",
  },
  "0.43.4+aleph.1": {
    date: "September 24, 2026",
    headline:
      "Aleph: thread-bound Account Pooler availability, bb pool exec, and provider icons",
  },
  "0.43.3": {
    date: "September 18, 2026",
    headline: "Saved drafts, browser annotations, and live browser previews",
  },
  "0.43.0": {
    date: "September 11, 2026",
    headline: "Custom environments, machine plugins, and browser control",
  },
  "0.42.0": {
    date: "September 5, 2026",
    headline: "Account Pooler, push notifications, and a new plugin catalog",
  },
  "0.41.0": {
    date: "September 1, 2026",
    headline: "Scheduled sends, concurrency limits, and a rebuilt mobile app",
  },
  "0.40.0": {
    date: "August 26, 2026",
    headline: "File Editor, quick palette, and agent providers",
  },
  "0.39.0": {
    date: "August 19, 2026",
    headline: "Faster large threads and a long list of fixes",
  },
  "0.38.0": {
    date: "August 15, 2026",
    headline: "Extensions Page and Plugin Marketplaces",
  },
  "0.37.0": {
    date: "August 11, 2026",
    headline: "A much faster mobile app",
  },
  "0.36.0": {
    date: "August 8, 2026",
    headline: "Fixes and improvements",
  },
  "0.35.0": {
    date: "August 4, 2026",
    headline: "Plugins",
  },
  "0.34.0": {
    date: "July 28, 2026",
    headline: "Fresher models, cross-provider questions",
  },
  "0.33.0": {
    date: "July 21, 2026",
    headline: "Quieter updates and safer approvals",
  },
  "0.0.31": {
    date: "July 17, 2026",
    headline: "Splits for everyone",
  },
  "0.0.30": {
    date: "July 14, 2026",
    headline: "Multi-machine workflows and bb Connect",
  },
  "0.0.29": {
    date: "July 9, 2026",
    headline: "More agents, more models, redesigned Settings",
  },
};
