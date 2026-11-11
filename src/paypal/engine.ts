/**
 * PayPal deterministic policy engine — pure function, no I/O.
 *
 * Guarantees:
 * - No network, wallet, key, database, credential, or clock access. Time
 *   (`now`) is injected via context for reproducibility.
 * - Fails closed: any malformed input or config yields rejection.
 * - Deterministic: reasons sorted by PAYPAL_REASON_ORDER then message;
 *   identical input always yields identical output.
 * - Approval never overrides policy: MISSING_APPROVAL is appended LAST and
 *   only matters when every other check passes.
 * - `allowed: true` means POLICY SATISFIED ONLY — not authorized, not
 *   executable. Order creation, buyer approval, capture, and verification
 *   arrive in later phases and must re-check policy before any PayPal call.
 * - USD minor units (cents) only. No wei, no chainId, no EVM addresses.
 *
 * Expiry boundary: a request is EXPIRED when `now >= expiresAt`.
 * Equality (now === expiresAt) is therefore rejected.
 */
import {
  PAYPAL_ABSOLUTE_MAX_MINOR,
  PAYPAL_REASON_ORDER,
  type PayPalAllowed,
  type PayPalContext,
  type PayPalDecision,
  type PayPalIntent,
  type PayPalPolicyConfig,
  type PayPalReason,
  type PayPalRejectionCode,
} from "./types.js";
import {
  isPlainObject,
  normalizePayPalReceiver,
  parsePayPalContext,
  toCanonicalReceiver,
  validatePayPalAmountMinor,
  validatePayPalCurrency,
  validatePayPalExpiresAt,
  validatePayPalNonce,
  validatePayPalPurpose,
  validatePayPalReceiver,
  validatePayPalConfig,
  validatePayPalRequestId,
} from "./validation.js";

const ORDER_INDEX: ReadonlyMap<PayPalRejectionCode, number> = new Map(
  PAYPAL_REASON_ORDER.map((code, i) => [code, i]),
);

export function sortPayPalReasons(reasons: PayPalReason[]): PayPalReason[] {
  return [...reasons].sort((a, b) => {
    const oa = ORDER_INDEX.get(a.code) ?? 999;
    const ob = ORDER_INDEX.get(b.code) ?? 999;
    if (oa !== ob) return oa - ob;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}

function isExpired(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}

export function evaluatePayPalPolicy(
  intent: unknown,
  config: unknown,
  context: unknown,
): PayPalDecision {
  // 1. Config first — never evaluate against an unsafe config.
  const configReasons = validatePayPalConfig(config);
  if (configReasons.length > 0) return { allowed: false, reasons: sortPayPalReasons(configReasons) };
  const cfg = config as PayPalPolicyConfig;

  const reasons: PayPalReason[] = [];

  // 2. Context must be well-formed; malformed context fails closed.
  const parsed = parsePayPalContext(context);
  reasons.push(...parsed.reasons);

  // 3. Intent must be a plain object.
  if (!isPlainObject(intent)) {
    reasons.push({ code: "INVALID_REQUEST", message: "intent must be an object" });
    return { allowed: false, reasons: sortPayPalReasons(reasons) };
  }
  const raw = intent as Record<string, unknown>;
  const intentT = intent as Partial<PayPalIntent>;

  // Required-field presence check (deterministic field order).
  const requiredFields = [
    "requestId",
    "receiver",
    "amountMinor",
    "currency",
    "purpose",
    "nonce",
    "expiresAt",
  ] as const;
  for (const f of requiredFields) {
    if (!(f in raw) || raw[f] === undefined) {
      reasons.push({ code: "INVALID_REQUEST", message: `missing required field: ${f}` });
    }
  }

  // 4. Field validations in documented deterministic order.
  reasons.push(...validatePayPalRequestId(intentT.requestId));
  reasons.push(...validatePayPalNonce(intentT.nonce));
  reasons.push(...validatePayPalExpiresAt(intentT.expiresAt));
  reasons.push(...validatePayPalPurpose(intentT.purpose));
  reasons.push(...validatePayPalCurrency(intentT.currency));
  reasons.push(...validatePayPalReceiver(intentT.receiver));

  const amountReasons = validatePayPalAmountMinor(intentT.amountMinor);
  reasons.push(...amountReasons);
  const amountValid = amountReasons.length === 0 && typeof intentT.amountMinor === "bigint";

  // 5. Allowlist (only when receiver is well-formed).
  const canonical = toCanonicalReceiver(intentT.receiver);
  if (canonical !== null) {
    const allow = new Set(
      (cfg.allowedReceivers as string[]).map((a) => normalizePayPalReceiver(a)),
    );
    if (!allow.has(canonical)) {
      reasons.push({ code: "NOT_ALLOWLISTED", message: "receiver is not in the approved allowlist" });
    }
  }

  // 6. Spending limit (only when amount is a valid positive bigint).
  // Independent absolute-ceiling re-assertion: even a misconfigured caller
  // cannot slip an over-ceiling amount through this boundary.
  if (amountValid) {
    const amount = intentT.amountMinor as bigint;
    if (amount > PAYPAL_ABSOLUTE_MAX_MINOR) {
      reasons.push({ code: "EXCEEDS_LIMIT", message: "amount exceeds the absolute $10.00 ceiling" });
    } else if (amount > (cfg.maxPerPaymentMinor as bigint)) {
      reasons.push({ code: "EXCEEDS_LIMIT", message: "amount exceeds maximum per-payment limit" });
    }
  }

  // 7. Expiry (only when both timestamps are valid integers).
  if (
    typeof intentT.expiresAt === "number" &&
    Number.isInteger(intentT.expiresAt) &&
    parsed.reasons.length === 0
  ) {
    if (isExpired(intentT.expiresAt, parsed.now)) {
      reasons.push({ code: "EXPIRED_REQUEST", message: "request has expired" });
    }
  }

  // 8. Approval LAST — never bypasses any other violation.
  const ctx = context as Partial<PayPalContext> | null;
  void ctx;
  if (cfg.requireHumanApproval === true && parsed.approval !== true) {
    reasons.push({ code: "MISSING_APPROVAL", message: "human approval has not been verified" });
  }

  if (reasons.length > 0) return { allowed: false, reasons: sortPayPalReasons(reasons) };

  const allowed: PayPalAllowed = {
    allowed: true,
    requiresApproval: cfg.requireHumanApproval,
    approvalVerified: parsed.approval,
    currency: intentT.currency as PayPalAllowed["currency"],
  };
  return allowed;
}
