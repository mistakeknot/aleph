import type { WikiDiscovery } from "./wiki-discovery.js";
import type { ClaimMarker, WikiPage } from "./wiki-types.js";

export interface ClaimTarget {
  label: string;
  context: string;
  ordinal: number;
  groupSize: number;
}

export interface PinAnchorInput {
  pageId: string;
  sourcePath: string;
  claim: ClaimTarget | null;
}

export type PinAnchor =
  | { state: "page" }
  | { state: "claim"; line: number; identical: boolean }
  | {
      state: "detached";
      reason: "claim-changed" | "ambiguous" | "page-missing";
    }
  | { state: "unverified"; reason: string };

export type ClaimVerification =
  | { ok: true }
  | { ok: false; reason: "unknown-claim" | "stale-claim" };

export function claimContext(body: string, claim: ClaimMarker): string {
  const line = body.split("\n")[claim.line - 1] ?? "";
  return line.replace(/\r$/, "").trim();
}

function sameKey(
  page: WikiPage,
  claim: ClaimMarker,
  label: string,
  context: string,
): boolean {
  return claim.label === label && claimContext(page.body, claim) === context;
}

function groupOf(
  page: WikiPage,
  label: string,
  context: string,
): ClaimMarker[] {
  return page.claims.filter((claim) => sameKey(page, claim, label, context));
}

export function claimTargetAt(
  page: WikiPage,
  claimIndex: number,
): ClaimTarget | null {
  const claim = page.claims[claimIndex];
  if (claim === undefined) return null;
  const context = claimContext(page.body, claim);
  const group = groupOf(page, claim.label, context);
  return {
    label: claim.label,
    context,
    ordinal: group.indexOf(claim),
    groupSize: group.length,
  };
}

export function verifyClaimTarget(
  page: WikiPage,
  target: ClaimTarget,
): ClaimVerification {
  const group = groupOf(page, target.label, target.context);
  if (group.length === 0) return { ok: false, reason: "unknown-claim" };
  if (group.length !== target.groupSize)
    return { ok: false, reason: "stale-claim" };
  if (target.ordinal < 0 || target.ordinal >= target.groupSize) {
    return { ok: false, reason: "stale-claim" };
  }
  return { ok: true };
}

function resolveClaim(page: WikiPage, target: ClaimTarget): PinAnchor {
  const group = groupOf(page, target.label, target.context);
  if (group.length === 0) return { state: "detached", reason: "claim-changed" };
  if (group.length !== target.groupSize)
    return { state: "detached", reason: "ambiguous" };
  const claim = group[target.ordinal];
  if (claim === undefined) return { state: "detached", reason: "ambiguous" };
  return { state: "claim", line: claim.line, identical: group.length > 1 };
}

export function resolvePinAnchor(
  pin: PinAnchorInput,
  discovery: WikiDiscovery,
): PinAnchor {
  const { list } = discovery;
  const conflict = list.errors.find((error) => error.pageId === pin.pageId);
  if (conflict !== undefined)
    return { state: "unverified", reason: conflict.message };
  const page = discovery.pages.find((candidate) => candidate.id === pin.pageId);
  if (page !== undefined) {
    return pin.claim === null
      ? { state: "page" }
      : resolveClaim(page, pin.claim);
  }
  if (list.state === "unavailable") {
    return {
      state: "unverified",
      reason: list.message ?? "The wiki could not be read.",
    };
  }
  if (list.errors.length > 0) {
    const own = list.errors.find((error) => error.path === pin.sourcePath);
    return {
      state: "unverified",
      reason:
        own?.message ??
        "Some wiki files could not be read, so this page cannot be confirmed gone.",
    };
  }
  return { state: "detached", reason: "page-missing" };
}
