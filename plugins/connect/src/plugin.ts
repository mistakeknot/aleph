import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createAccountClient,
  watchAccount,
} from "bb-plugin-bb-account/src/client.js";
import { resolveDefaultConnectBaseUrl } from "@bb/connect-client";
import { registerConnectCli } from "./cli.js";
import { HostedConnectApi } from "./hosted.js";
import { ShareHostResolver } from "./hosts.js";
import {
  CredentialCopy,
  createCredentialCopyStore,
} from "./credential-copy.js";
import { resolveLocalCloudLoopbackUrl } from "./local-loopback.js";
import {
  connectRpcContract,
  createRpcHandlers,
  type RemoteAccessSwitch,
} from "./rpc.js";
import {
  createServerAccessCloud,
  createServerAccessRecheck,
  registerServerAccess,
} from "./server-access.js";
import { NextAddress, nextSharePublicUrl } from "./next-address.js";
import {
  ShareChanges,
  connectServerSharesRpcContract,
  createServerSharesHandlers,
} from "./server-shares.js";
import { ShareRegistry } from "./shares.js";
import { sharePublicUrl } from "./shares.js";
import {
  AnnotationStore,
  annotationRpcContract,
  requireDeclaredAnnotationShare,
} from "./annotation-store.js";
import { AnnotationTunnel } from "./annotation-tunnel.js";
import { ConnectTunnel } from "./tunnel.js";
import {
  CONNECT_REALTIME_CHANNEL,
  REMOTE_ACTIVITY_INSTRUCTIONS_MS,
} from "./types.js";

export interface ConnectPluginOptions {
  accountRetryMinMs?: number;
  serverSharesLongPollMs?: number;
}

export function createConnectPlugin(options: ConnectPluginOptions = {}) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    const settings = bb.settings.define({
      remoteAccess: {
        type: "boolean",
        label: "Remote access",
        description:
          "Keep this bb reachable at its getbb.app address while it is signed in to your bb account. Turning it off keeps the account signed in.",
        default: true,
      },
      sendRemoteInstructions: {
        type: "boolean",
        label: "Tell agents about remote access",
        description:
          "When you use BB remotely, tell agents to share servers through Connect. Applies to new agent sessions.",
        default: true,
      },
    });
    let currentSettings = await settings.get();
    const account = createAccountClient(() => bb.sdk);
    const hosted = new HostedConnectApi(account);
    let tunnel!: ConnectTunnel;
    const hostResolver = new ShareHostResolver(() => bb.sdk);
    const getLoopbackBaseUrl = () =>
      resolveLocalCloudLoopbackUrl(
        tunnel.getIdentity()?.serverUrl,
        process.env.BB_DEV_APP_PORT,
      ) ?? bb.server.loopbackBaseUrl;

    const shareChanges = new ShareChanges();
    const nextAddress = new NextAddress(() => bb.sdk);
    const shares = new ShareRegistry({
      kv: bb.storage.kv,
      hosts: bb.hosts,
      hostResolver,
      getLoopbackBaseUrl,
      getIdentity: () => tunnel.getIdentity(),
      log: bb.log,
      onChange: () => {
        shareChanges.bump();
        bb.realtime.publish(CONNECT_REALTIME_CHANNEL, tunnel.status());
      },
      nextOrigin: () => nextAddress.refresh(),
    });

    bb.events.on("experimental_host.deleted", async ({ host }) => {
      await shares.pruneHost(host.id);
    });

    const recheckServerAccess = createServerAccessRecheck(bb);
    const annotations = new AnnotationStore(
      bb.storage.kv,
      async (port, scope) => {
        if (scope.hostId !== undefined) {
          requireDeclaredAnnotationShare(
            scope,
            await shares.list(scope.hostId),
          );
          return;
        }
        if (!shares.hasServerPort(port))
          throw new Error("This server port is not shared");
      },
    );
    const annotationTunnel = new AnnotationTunnel(annotations, (port) => {
      const identity = tunnel.getIdentity();
      return identity && shares.hasServerPort(port)
        ? new URL(sharePublicUrl(identity, port)).origin
        : null;
    });
    bb.rpc.register(annotationRpcContract, {
      "connect.experimental_annotations.list": async (input) =>
        annotations.list(input),
      "connect.experimental_annotations.change": async (input) =>
        annotations.change(
          { hostId: input.hostId, port: input.port, url: input.url },
          input.change,
        ),
    });
    tunnel = new ConnectTunnel({
      annotations: annotationTunnel,
      shares,
      readCredential: () => account.connectCredential(),
      confirmRefusedCredential: (credential) =>
        account.confirmRefusedCredential(credential),
      defaultBaseUrl: resolveDefaultConnectBaseUrl(process.env),
      enabled: currentSettings.remoteAccess,
      getLoopbackBaseUrl,
      log: bb.log,
      onStatusChange: (status) => {
        bb.realtime.publish(CONNECT_REALTIME_CHANNEL, status);
        recheckServerAccess(status);
      },
    });
    settings.onChange((next) => {
      currentSettings = next;
      tunnel.setEnabled(next.remoteAccess);
    });

    const remoteAccess: RemoteAccessSwitch = {
      async set(enabled) {
        await settings.experimental_set({ remoteAccess: enabled });
        tunnel.setEnabled(enabled);
        return tunnel.refreshStatus();
      },
    };

    await registerServerAccess(bb, {
      cloud: createServerAccessCloud(hosted),
      status: () => tunnel.status(),
    });

    bb.rpc.register(
      connectRpcContract,
      createRpcHandlers({
        tunnel,
        hosted,
        hostResolver,
        remoteAccess,
      }),
    );
    bb.rpc.register(
      connectServerSharesRpcContract,
      createServerSharesHandlers({
        changes: shareChanges,
        serverPorts: () => shares.serverPorts(),
        ...(options.serverSharesLongPollMs === undefined
          ? {}
          : { longPollMs: options.serverSharesLongPollMs }),
      }),
    );
    registerConnectCli({
      annotations,
      bb,
      tunnel,
      account,
      hosted,
      hostResolver,
      remoteAccess,
    });

    bb.agents.contributeInstructions(() => {
      if (!currentSettings.sendRemoteInstructions) return null;
      const status = tunnel.status();
      if (!status.paired || !status.enabled || status.url === null) return null;
      const recent =
        status.remoteClients > 0 ||
        (status.lastRemoteActivityAt !== null &&
          Date.now() - status.lastRemoteActivityAt <
            REMOTE_ACTIVITY_INSTRUCTIONS_MS);
      if (!recent) return null;
      const nextOrigin = nextAddress.current();
      return (
        `The user is currently viewing this bb remotely at ${status.url}. ` +
        "Port shares work from a thread on any enrolled host: when you start an HTTP server they should see, run `bb connect expose <port>` from that thread. " +
        "The command returns the correct public URL for the thread's host; give it to them as a markdown link because a localhost URL will not work remotely." +
        (nextOrigin === null
          ? ""
          : ` This bb is also reachable through bb connect next at ${nextOrigin}, so the command prints a second URL on the next address (${nextSharePublicUrl(nextOrigin, "<port>")} for ports on the bb server's machine, <machine-label>--<port> on the same domain for other machines); give the user both, or the one matching the address they use.`)
      );
    });

    const copy = new CredentialCopy({
      account,
      store: createCredentialCopyStore(bb.storage.kv),
      log: bb.log,
    });

    bb.background.service("tunnel", {
      async start(signal) {
        await tunnel.start();
        await watchAccount(
          {
            account,
            log: bb.log,
            onAccount: (next) => tunnel.setAccount(next),
            sync: (status) => copy.sync(status),
            ...(options.accountRetryMinMs === undefined
              ? {}
              : { retryMinMs: options.accountRetryMinMs }),
          },
          signal,
        );
        tunnel.stop();
      },
    });
  };
}
