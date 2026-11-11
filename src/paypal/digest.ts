/**
 * Deterministic PayPal policy digest — PayPal MVP (Phase 4A).
 *
 * CANONICALIZATION RULES (all required for byte-identical digests):
 * 1. currency: exact string ("USD").
 * 2. maxPerPaymentMinor: exact bigint cents → decimal string. No floats.
 * 3. requireHumanApproval: exact boolean → "1" | "0".
 * 4. allowlist: each receiver trimmed, lowercased, deduped, then sorted
 *    ascending by UTF-8 byte order; duplicates impossible post-validation.
 * 5. Encoding: UTF-8 string
 *    `paypal-v1|USD|<maxMinor>|<0|1>|<receiver0>,<receiver1>,...`
 *    hashed with SHA-256 (node:crypto, pure, no network), returned as
 *    0x-prefixed 32-byte hex (66 chars) to match the repo's digest shape.
 *
 * Deliberately NOT JSON: object insertion order and whitespace can never
 * affect the digest. Any change to any authorization-relevant policy field
 * changes the digest, invalidating approvals recorded under the old policy.
 * No Monad fields (chainId, wei, EVM addresses) participate.
 */
import { createHash } from "node:crypto";
import type { PayPalPolicyConfig } from "./types.js";
import { normalizePayPalReceiver } from "./validation.js";

/** Canonical sorted lowercase receiver allowlist. Exported for tests. */
export function canonicalPayPalReceivers(allowedReceivers: string[]): string[] {
  const normalized = allowedReceivers.map((a) => normalizePayPalReceiver(a));
  return [...new Set(normalized)].sort();
}

export function computePayPalPolicyDigest(policy: PayPalPolicyConfig): string {
  const receivers = canonicalPayPalReceivers(policy.allowedReceivers);
  const canonical =
    `paypal-v1|${policy.currency}|${(policy.maxPerPaymentMinor as bigint).toString()}|` +
    `${policy.requireHumanApproval ? "1" : "0"}|${receivers.join(",")}`;
  const hex = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `0x${hex}`;
}

/**
 * Deterministic digest of the exact payment intent. This binds an approval to
 * the request ID, receiver, amount, currency, purpose, nonce, and expiry. It
 * is intentionally independent of provider order/capture IDs: those are
 * attached later and verified against this digest.
 */
export function computePayPalPaymentDigest(intent: {
  requestId: string;
  receiver: string;
  amountMinor: bigint;
  currency: string;
  purpose: string;
  nonce: string;
  expiresAt: number;
}): string {
  const canonical = JSON.stringify([
    "paypal-payment-v1",
    intent.requestId,
    normalizePayPalReceiver(intent.receiver),
    intent.amountMinor.toString(),
    intent.currency,
    intent.purpose,
    intent.nonce,
    intent.expiresAt,
  ]);
  const hex = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `0x${hex}`;
}
