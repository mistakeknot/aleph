import { WebSocket as NodeWebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_QUERY_PARAM,
  TUNNEL_REPLACED_CLOSE_REASON,
} from "@bb/tunnel-contract";
import {
  humanizeTransportError,
  ReconnectBackoff,
  TunnelSession,
  type StreamOriginResult,
} from "@bb/tunnel-client";
import type { PluginLogger } from "@get-bb/plugin-sdk";
import {
  ConnectListError,
  deriveConnectBaseUrl,
  fetchDesktopSession,
  listAccountServers,
  serverUrlForHandle,
  type ConnectCredential,
  type DesktopSession,
  type ListAccountServersResult,
} from "@bb/connect-client";
import type { CredentialStore, StoredRelayIdentity } from "./credential.js";
import { fetchMachineCode, MachineCodeError } from "./machine-code.js";
import { asConnectPairError, redeemConnectCode } from "./redeem.js";
import { revokeMachine } from "./revoke-machine.js";
import {
  ShareRegistry,
  shareLoopbackHost,
  shareLoopbackOrigin,
  sharePublicUrl,
  type ShareRemoval,
} from "./shares.js";
import type { ShareHost } from "./hosts.js";
import type { ConnectStateName, ConnectStatus, ShareListing } from "./types.js";

const DISCONNECT_TIMEOUT_MS = 5_000;
const TUNNEL_HANDSHAKE_TIMEOUT_MS = 10_000;
const TUNNEL_CLOSE_GRACE_MS = 1_000;
const TUNNEL_CLEAN_CLOSE_CODE = 1000;
const TUNNEL_REPLACED_RETRY_MS = 5 * 60_000;
const RELAY_RECONCILE_RETRY_MS = 30_000;

async function notifyCloudOfDisconnect(
  credential: ConnectCredential,
): Promise<void> {
  const response = await fetch(
    new URL("/api/connect/disconnect", credential.serverUrl),
    {
      method: "POST",
      headers: { "x-bb-connect-machine": credential.credential },
      signal: AbortSignal.timeout(DISCONNECT_TIMEOUT_MS),
    },
  );
  if (!response.ok && response.status !== 401 && response.status !== 403) {
    throw new Error(`Cloud returned HTTP ${response.status}`);
  }
}

interface ConnectTunnelOptions {
  store: CredentialStore;
  shares: ShareRegistry;
  defaultBaseUrl: string;
  getLoopbackBaseUrl: () => string;
  log: PluginLogger;
  onStatusChange?: (status: ConnectStatus) => void;
  bindRelayIdentity?: (
    binding: {
      baseUrl: string;
      ownerUserId: string;
      serverId: string;
    },
    options?: { replaceExisting?: boolean },
  ) => void;
  markRelayIdentityReconciled?: (reconciled: boolean) => boolean;
  hasRelayIdentity?: () => boolean;
}

export class ConnectTunnel {
  private credential: ConnectCredential | null = null;
  private tunnel: NodeWebSocket | undefined;
  private session: TunnelSession | undefined;
  private connected = false;
  private pairing = false;
  private lastError: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly backoff = new ReconnectBackoff();
  private stopped = false;
  private lastState: ConnectStateName = "disconnected";
  private stateSince = Date.now();
  private lastRemoteActivityAt: number | null = null;
  private remoteClients = 0;
  private nextRetryAt: number | null = null;
  private shareRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private shareActivationEpoch = 0;
  private relayUnreconciled = false;
  private relayConflict = false;
  private relayQueue: Promise<unknown> = Promise.resolve();
  private relayReconcileTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ConnectTunnelOptions) {}

  getCredential(): ConnectCredential | null {
    return this.credential;
  }

  async start(): Promise<void> {
    const stored = await this.serialize(() => this.reconcileRelayIdentity());
    if (stored) {
      this.credential = stored;
      this.stopped = false;
      this.openTunnel();
    }
    this.startShareActivation();
    this.publish();
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.relayQueue.then(task, task);
    this.relayQueue = run.catch(() => undefined);
    return run;
  }

  private async readSnapshot(): Promise<{
    credential: ConnectCredential | null;
    relayIdentity: StoredRelayIdentity | null;
  }> {
    const { store } = this.options;
    if (store.readSnapshot !== undefined) return store.readSnapshot();
    return { credential: await store.read(), relayIdentity: null };
  }

  private async reconcileRelayIdentity(): Promise<ConnectCredential | null> {
    const { store } = this.options;
    if (this.relayReconcileTimer) {
      clearTimeout(this.relayReconcileTimer);
      this.relayReconcileTimer = undefined;
    }
    let credential: ConnectCredential | null = null;
    try {
      this.options.markRelayIdentityReconciled?.(false);
      const snapshot = await this.readSnapshot();
      credential = snapshot.credential;
      if (snapshot.credential === null || snapshot.relayIdentity === null) {
        this.options.bindRelayIdentity?.({
          baseUrl: this.options.defaultBaseUrl,
          ownerUserId: "",
          serverId: "",
        });
      } else {
        this.options.bindRelayIdentity?.(snapshot.relayIdentity);
        this.options.markRelayIdentityReconciled?.(true);
      }
      this.relayUnreconciled = false;
      this.relayConflict = false;
    } catch (error) {
      this.markRelayUnreconciled(error);
      if (credential === null) {
        try {
          credential = await store.read();
        } catch {
          credential = null;
        }
      }
    }
    return credential;
  }

  private markRelayUnreconciled(error: unknown): void {
    this.relayUnreconciled = true;
    if (
      error instanceof Error &&
      error.name === "ConnectBindingConflictError"
    ) {
      this.relayConflict = true;
      this.options.log.error(
        "relay binding belongs to a different Connect identity; leaving it untouched and staying fenced. Re-pair this bb to take it over.",
      );
    } else {
      this.options.log.error(
        `relay identity is not reconciled with the stored credential: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (this.relayReconcileTimer) return;
    this.relayReconcileTimer = setTimeout(() => {
      this.relayReconcileTimer = undefined;
      void this.serialize(() => this.reconcileRelayIdentity()).finally(() =>
        this.publish(),
      );
    }, RELAY_RECONCILE_RETRY_MS);
  }

  async pair(args: {
    code: string;
    serverUrl?: string;
    baseUrl?: string;
  }): Promise<ConnectStatus> {
    const baseUrl =
      args.baseUrl ??
      (args.serverUrl !== undefined
        ? deriveConnectBaseUrl(args.serverUrl)
        : this.options.defaultBaseUrl);
    this.pairing = true;
    this.publish();
    try {
      let redeemed;
      try {
        redeemed = await redeemConnectCode({ code: args.code, baseUrl });
      } catch (error) {
        const pairError = asConnectPairError(error);
        this.options.log.warn(
          `pair failed (${pairError.code}): ${pairError.message}`,
        );
        throw pairError;
      }
      const serverUrl = (
        args.serverUrl ?? serverUrlForHandle(baseUrl, redeemed.handle)
      ).replace(/\/$/, "");
      const credential: ConnectCredential = {
        serverUrl,
        handle: redeemed.handle,
        credential: redeemed.credential,
      };
      const identity =
        redeemed.ownerUserId !== "" && redeemed.serverId !== ""
          ? {
              baseUrl,
              ownerUserId: redeemed.ownerUserId,
              serverId: redeemed.serverId,
            }
          : undefined;
      await this.serialize(async () => {
        try {
          this.options.markRelayIdentityReconciled?.(false);
          this.options.bindRelayIdentity?.(
            {
              baseUrl,
              ownerUserId: redeemed.ownerUserId,
              serverId: redeemed.serverId,
            },
            { replaceExisting: true },
          );
        } catch (error) {
          this.clearRelayIdentity();
          this.options.log.warn(
            `pair failed while binding relay identity: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          throw error;
        }
        try {
          await this.options.store.write(credential, identity);
        } catch (error) {
          this.clearRelayIdentity();
          throw error;
        }
        try {
          if (identity !== undefined) {
            this.options.markRelayIdentityReconciled?.(true);
          }
          this.relayUnreconciled = false;
          this.relayConflict = false;
        } catch (error) {
          this.markRelayUnreconciled(error);
        }
      });
      this.credential = credential;
      this.lastError = null;
      this.reconnect();
      this.startShareActivation();
    } finally {
      this.pairing = false;
      this.publish();
    }
    return this.status();
  }

  private clearRelayIdentity(): void {
    try {
      this.options.markRelayIdentityReconciled?.(false);
      this.options.bindRelayIdentity?.({
        baseUrl: this.options.defaultBaseUrl,
        ownerUserId: "",
        serverId: "",
      });
      this.relayConflict = false;
    } catch (error) {
      this.markRelayUnreconciled(error);
    }
  }

  async disconnect(): Promise<ConnectStatus> {
    const credential = this.credential;
    this.teardown();
    await this.serialize(async () => {
      this.clearRelayIdentity();
      await this.options.store.clear();
    });
    this.options.shares.clearMachineDeclarations();
    this.credential = null;
    this.lastError = null;
    this.publish();
    if (credential !== null) {
      try {
        await notifyCloudOfDisconnect(credential);
      } catch (error) {
        this.options.log.warn(
          `Cloud disconnect could not be confirmed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return this.status();
  }

  async expose(port: number, host: ShareHost): Promise<ShareListing> {
    const listing = await this.options.shares.add(port, host);
    this.publish();
    return listing;
  }

  async unexpose(
    port: number,
    hostSelector: string,
  ): Promise<ShareRemoval & { port: number }> {
    const result = await this.options.shares.remove(port, hostSelector);
    this.publish();
    return { ...result, port };
  }

  async listShares(hostId?: string): Promise<ShareListing[]> {
    return this.options.shares.list(hostId);
  }

  async listAccountServers(): Promise<ListAccountServersResult> {
    const credential = this.credential;
    if (credential === null) {
      throw new ConnectListError(
        "not_paired",
        "this bb is not connected to getbb.app — run `bb connect` for how to pair",
      );
    }
    return listAccountServers(credential);
  }

  async createDesktopSession(): Promise<DesktopSession> {
    if (this.credential === null) {
      throw new ConnectListError("not_paired", "this bb is not connected");
    }
    return fetchDesktopSession(this.credential);
  }

  async createMachineCode() {
    if (this.credential === null) {
      throw new MachineCodeError("not_paired");
    }
    return fetchMachineCode(this.credential, AbortSignal.timeout(10_000));
  }

  async revokeMachine(machineId: string): Promise<void> {
    const credential = this.getCredential();
    if (credential === null) throw new Error("not_paired");
    await revokeMachine(credential, machineId);
  }

  status(): ConnectStatus {
    return this.statusWithShares(this.options.shares.snapshot());
  }

  async refreshStatus(): Promise<ConnectStatus> {
    return this.statusWithShares(await this.listShares());
  }

  private statusWithShares(shares: ConnectStatus["shares"]): ConnectStatus {
    const state = this.computeState();
    return {
      state,
      paired: this.credential !== null,
      handle: this.credential?.handle ?? null,
      url: this.credential?.serverUrl ?? null,
      dashboardUrl: this.dashboardUrl(),
      lastError: this.lastError,
      nextRetryAt: state === "reconnecting" ? this.nextRetryAt : null,
      since: this.stateSince,
      remoteClients: this.remoteClients,
      lastRemoteActivityAt: this.lastRemoteActivityAt,
      relayBinding:
        !this.relayUnreconciled && (this.options.hasRelayIdentity?.() ?? false),
      relayConflict: this.relayConflict,
      shares,
    };
  }

  private dashboardUrl(): string {
    const base =
      this.credential !== null
        ? deriveConnectBaseUrl(this.credential.serverUrl)
        : this.options.defaultBaseUrl;
    return `${base.replace(/\/$/, "")}/dashboard`;
  }

  stop(): void {
    if (this.relayReconcileTimer) {
      clearTimeout(this.relayReconcileTimer);
      this.relayReconcileTimer = undefined;
    }
    this.teardown();
    this.publish();
  }

  private computeState(): ConnectStateName {
    if (this.pairing) return "pairing";
    if (this.credential === null) return "disconnected";
    return this.connected ? "connected" : "reconnecting";
  }

  private publish(): void {
    const state = this.computeState();
    if (state !== this.lastState) {
      this.lastState = state;
      this.stateSince = Date.now();
    }
    this.options.onStatusChange?.(this.status());
  }

  private teardown(): void {
    this.shareActivationEpoch += 1;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.shareRetryTimer) {
      clearTimeout(this.shareRetryTimer);
      this.shareRetryTimer = undefined;
    }
    this.session?.dispose();
    this.session = undefined;
    this.remoteClients = 0;
    const tunnel = this.tunnel;
    if (tunnel !== undefined && tunnel.readyState === NodeWebSocket.OPEN) {
      tunnel.close(TUNNEL_CLEAN_CLOSE_CODE, "tunnel closed by bb");
      setTimeout(() => tunnel.terminate(), TUNNEL_CLOSE_GRACE_MS).unref?.();
    } else {
      tunnel?.terminate();
    }
    this.tunnel = undefined;
    this.connected = false;
    this.backoff.reset();
    this.nextRetryAt = null;
  }

  private reconnect(): void {
    this.teardown();
    this.stopped = false;
    this.openTunnel();
  }

  private startShareActivation(): void {
    const epoch = ++this.shareActivationEpoch;
    void this.activateShares(epoch);
  }

  private isShareActivationCurrent(epoch: number): boolean {
    return !this.stopped && epoch === this.shareActivationEpoch;
  }

  private async activateShares(epoch: number): Promise<void> {
    try {
      await this.options.shares.load();
      if (!this.isShareActivationCurrent(epoch)) return;
      await this.options.shares.declareMachineShares(() =>
        this.isShareActivationCurrent(epoch),
      );
      if (!this.isShareActivationCurrent(epoch)) return;
      if (this.credential !== null) {
        await this.options.shares.list();
        if (!this.isShareActivationCurrent(epoch)) return;
      }
      this.publish();
    } catch (error) {
      this.options.log.warn(
        `shared-port activation failed; retrying: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (
        this.credential !== null &&
        this.isShareActivationCurrent(epoch) &&
        this.shareRetryTimer === undefined
      ) {
        this.shareRetryTimer = setTimeout(() => {
          this.shareRetryTimer = undefined;
          this.startShareActivation();
        }, 5_000);
      }
    }
  }

  private credentialRejected(statusCode: number): void {
    this.lastError =
      `the gate rejected this bb's credential (HTTP ${statusCode}) — ` +
      "pairing was revoked; get a new code from the getbb.app dashboard and re-pair";
    this.options.log.warn(this.lastError);
    this.credential = null;
    this.teardown();
    this.publish();
    void this.serialize(async () => {
      this.clearRelayIdentity();
      await this.options.store.clear();
    }).catch((error: unknown) => {
      this.options.log.warn(
        `failed to clear the rejected credential: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private resolveStreamOrigin(target: string | undefined): StreamOriginResult {
    if (target === undefined) {
      return {
        kind: "ok",
        resolved: {
          origin: this.options.getLoopbackBaseUrl().replace(/\/$/, ""),
          publicOrigin: this.credential
            ? new URL(this.credential.serverUrl).origin
            : this.options.getLoopbackBaseUrl(),
        },
      };
    }
    const port = Number(target);
    if (!Number.isInteger(port) || !this.options.shares.hasServerPort(port)) {
      return { kind: "unregistered" };
    }
    const credential = this.credential;
    if (credential === null) {
      return { kind: "unregistered" };
    }
    return {
      kind: "ok",
      resolved: {
        origin: shareLoopbackOrigin(port),
        publicOrigin: new URL(sharePublicUrl(credential, port)).origin,
        host: shareLoopbackHost(port),
      },
    };
  }

  private openTunnel(): void {
    const credential = this.credential;
    if (!credential || this.stopped) return;

    const tunnelUrl = tunnelUrlForServer(credential.serverUrl);
    this.options.log.info(
      `tunnel connecting to ${tunnelUrl} (origin ${this.options.getLoopbackBaseUrl()})`,
    );
    let tunnel: NodeWebSocket;
    try {
      tunnel = new NodeWebSocket(tunnelUrl, {
        headers: { authorization: `Bearer ${credential.credential}` },
        handshakeTimeout: TUNNEL_HANDSHAKE_TIMEOUT_MS,
      });
    } catch (error) {
      this.lastError = `cannot dial ${tunnelUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.options.log.warn(this.lastError);
      this.publish();
      return;
    }
    this.tunnel = tunnel;
    let connectedAt = 0;
    let retryScheduled = false;
    let handshakeDeadline: ReturnType<typeof setTimeout> | undefined;

    const scheduleReconnect = (
      detail: string,
      delayOverrideMs?: number,
    ): void => {
      if (retryScheduled || this.stopped || this.tunnel !== tunnel) {
        return;
      }
      retryScheduled = true;
      clearTimeout(handshakeDeadline);
      this.connected = false;
      this.session?.dispose();
      this.session = undefined;
      this.remoteClients = 0;
      const stable = connectedAt ? Date.now() - connectedAt : 0;
      const backoffDelay = this.backoff.nextDelayAfterClose(stable);
      const delay = delayOverrideMs ?? backoffDelay;
      if (this.lastError === null) {
        this.lastError = `can't reach ${connectApexHost(credential.serverUrl)} — connection closed`;
      }
      this.nextRetryAt = Date.now() + delay;
      this.options.log.warn(`${detail}; reconnecting in ${delay}ms`);
      this.reconnectTimer = setTimeout(() => {
        if (this.stopped || this.tunnel !== tunnel) return;
        this.reconnectTimer = undefined;
        this.nextRetryAt = null;
        this.publish();
        this.openTunnel();
      }, delay);
      this.publish();
    };

    handshakeDeadline = setTimeout(() => {
      if (retryScheduled || this.stopped || this.tunnel !== tunnel) return;
      this.lastError = `can't reach ${connectApexHost(credential.serverUrl)} — handshake timed out`;
      scheduleReconnect(this.lastError);
      tunnel.terminate();
    }, TUNNEL_HANDSHAKE_TIMEOUT_MS);
    handshakeDeadline.unref?.();

    tunnel.on("open", () => {
      if (retryScheduled || this.stopped || this.tunnel !== tunnel) {
        return;
      }
      clearTimeout(handshakeDeadline);
      connectedAt = Date.now();
      this.connected = true;
      this.lastError = null;
      this.nextRetryAt = null;
      this.options.log.info("tunnel connected");
      this.session = new TunnelSession({
        tunnel,
        log: this.options.log,
        resolveOrigin: (target) => this.resolveStreamOrigin(target),
        onRemoteClientsChange: (count) => {
          this.remoteClients = count;
          this.publish();
        },
        onActivity: (at) => {
          this.lastRemoteActivityAt = at;
        },
      });
      this.session.start();
      this.publish();
    });
    tunnel.on("unexpected-response", (_req, res) => {
      if (this.stopped || this.tunnel !== tunnel) return;
      res.resume();
      const statusCode = res.statusCode ?? 0;
      if (statusCode === 401 || statusCode === 403) {
        this.credentialRejected(statusCode);
        return;
      }
      this.lastError = `tunnel rejected: HTTP ${statusCode}`;
      scheduleReconnect(this.lastError);
      tunnel.terminate();
    });
    tunnel.on("error", (e: Error) => {
      if (retryScheduled || this.stopped || this.tunnel !== tunnel) {
        return;
      }
      this.lastError = humanizeTransportError(
        e,
        connectApexHost(credential.serverUrl),
      );
    });
    tunnel.on("close", (code: number, reason: Buffer) => {
      if (
        code === TUNNEL_CLEAN_CLOSE_CODE &&
        reason.toString() === TUNNEL_REPLACED_CLOSE_REASON
      ) {
        if (retryScheduled || this.stopped || this.tunnel !== tunnel) return;
        this.lastError =
          "another bb connected with this server's identity and took over bb connect";
        scheduleReconnect(this.lastError, TUNNEL_REPLACED_RETRY_MS);
        return;
      }
      scheduleReconnect(
        `tunnel closed (code ${code}${reason.length > 0 ? `, ${reason.toString()}` : ""})`,
      );
    });
  }
}

function connectApexHost(serverUrl: string): string {
  try {
    return new URL(deriveConnectBaseUrl(serverUrl)).host;
  } catch {
    return "getbb.app";
  }
}

function tunnelUrlForServer(serverUrl: string): string {
  const base =
    serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/__tunnel";
  const url = new URL(base);
  url.searchParams.set(TUNNEL_PROTOCOL_QUERY_PARAM, String(PROTOCOL_VERSION));
  return url.toString();
}
