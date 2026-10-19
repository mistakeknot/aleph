import type { HmacFn, RandomFn } from "./signal-protocol";

export const webCryptoHmac: HmacFn = async (key, data) => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new Uint8Array(data),
  );
  return new Uint8Array(signature);
};

export const webCryptoRandom: RandomFn = (n) =>
  crypto.getRandomValues(new Uint8Array(n));
