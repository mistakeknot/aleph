import { connectCredentialSchema } from "@bb/connect-client";
import type { ConnectCredential } from "@bb/connect-client";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const CREDENTIAL_KV_KEY = "credential";

const relayIdentitySchema = z.object({
  baseUrl: z.string().min(1),
  ownerUserId: z.string().min(1),
  serverId: z.string().min(1),
});

export type StoredRelayIdentity = z.infer<typeof relayIdentitySchema>;

export interface CredentialStore {
  read(): Promise<ConnectCredential | null>;
  readRelayIdentity?(): Promise<StoredRelayIdentity | null>;
  write(
    value: ConnectCredential,
    relayIdentity?: StoredRelayIdentity,
  ): Promise<void>;
  clear(): Promise<void>;
}

export function createKvCredentialStore(
  kv: Pick<PluginKvStorage, "get" | "set" | "delete">,
): CredentialStore {
  return {
    async read() {
      const raw = await kv.get<unknown>(CREDENTIAL_KV_KEY);
      if (raw === undefined) return null;
      const parsed = connectCredentialSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    async readRelayIdentity() {
      const raw = await kv.get<unknown>(CREDENTIAL_KV_KEY);
      if (typeof raw !== "object" || raw === null) return null;
      const parsed = relayIdentitySchema.safeParse(
        (raw as { relayIdentity?: unknown }).relayIdentity,
      );
      return parsed.success ? parsed.data : null;
    },
    async write(value, relayIdentity) {
      await kv.set(
        CREDENTIAL_KV_KEY,
        relayIdentity === undefined ? value : { ...value, relayIdentity },
      );
    },
    async clear() {
      await kv.delete(CREDENTIAL_KV_KEY);
    },
  };
}
