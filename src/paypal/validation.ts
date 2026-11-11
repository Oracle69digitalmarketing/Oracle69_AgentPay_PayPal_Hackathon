/**
 * PayPal validation helpers — pure, no I/O, no network, no credentials.
 *
 * All helpers validate UNTRUSTED runtime input (unknown) and fail closed.
 * This module is self-contained: it MUST NOT import from src/policy,
 * src/auth, or src/execution, so the PayPal path stays structurally isolated
 * from Monad concepts (MON, wei, chainId, EVM addresses, EIP-712).
 */
import {
  PAYPAL_ABSOLUTE_MAX_MINOR,
  PAYPAL_MAX_UINT256,
  USD_MINOR_PER_UNIT,
  type PayPalReason,
  type PayPalRejectionCode,
} from "./types.js";

export const PAYPAL_REQUEST_ID_MAX_LEN = 128;
export const PAYPAL_NONCE_MAX_LEN = 128;
export const PAYPAL_PURPOSE_MAX_LEN = 280;
export const PAYPAL_RECEIVER_MAX_LEN = 254;

/** Allowed chars for opaque ids: letters, digits, `_ - : .` */
const PAYPAL_ID_PATTERN = /^[A-Za-z0-9_\-:.]+$/;

/** Payer-id form: opaque, no `@`. Email form is detected by presence of `@`. */
const PAYER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Minimal email shape check (no network, no MX). Length bounded by RECEIVER_MAX_LEN. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function reason(code: PayPalRejectionCode, message: string): PayPalReason {
  return { code, message };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Scalar field validators (return PayPalReason[] so callers stay deterministic)
// ---------------------------------------------------------------------------

export function validatePayPalRequestId(v: unknown): PayPalReason[] {
  if (typeof v !== "string" || v.trim().length === 0)
    return [reason("INVALID_REQUEST", "requestId must be a non-empty string")];
  if (v.length > PAYPAL_REQUEST_ID_MAX_LEN || !PAYPAL_ID_PATTERN.test(v))
    return [reason("INVALID_REQUEST", "requestId is malformed")];
  return [];
}

export function validatePayPalNonce(v: unknown): PayPalReason[] {
  if (typeof v !== "string" || v.length === 0)
    return [reason("INVALID_REQUEST", "nonce must be a non-empty string")];
  if (v.length > PAYPAL_NONCE_MAX_LEN || !PAYPAL_ID_PATTERN.test(v))
    return [reason("INVALID_REQUEST", "nonce is malformed")];
  return [];
}

export function validatePayPalExpiresAt(v: unknown): PayPalReason[] {
  if (typeof v !== "number" || !Number.isInteger(v) || !Number.isFinite(v) || v < 0)
    return [reason("INVALID_REQUEST", "expiresAt must be a non-negative integer unix timestamp (seconds)")];
  return [];
}

export function validatePayPalPurpose(v: unknown): PayPalReason[] {
  if (typeof v !== "string" || v.trim().length === 0)
    return [reason("INVALID_REQUEST", "purpose must be a non-empty string")];
  if (v.length > PAYPAL_PURPOSE_MAX_LEN)
    return [reason("INVALID_REQUEST", "purpose exceeds maximum length")];
  return [];
}

export function validatePayPalCurrency(v: unknown): PayPalReason[] {
  if (v !== "USD") return [reason("INVALID_CURRENCY", "only currency USD is supported")];
  return [];
}

// ---------------------------------------------------------------------------
// Receiver validation — PayPal receiver only, never an EVM address
// ---------------------------------------------------------------------------

/** EVM address shape: never a valid PayPal receiver (keeps USD/EVM domains disjoint). */
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isWellFormedPayPalReceiver(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (s.length === 0 || s.length > PAYPAL_RECEIVER_MAX_LEN) return false;
  if (EVM_ADDRESS_PATTERN.test(s)) return false;
  if (s.includes("@")) return EMAIL_PATTERN.test(s);
  if (s.includes(".") || s.includes(":")) return PAYPAL_ID_PATTERN.test(s);
  return PAYER_ID_PATTERN.test(s);
}

/** Canonical form for allowlist comparison: trimmed, lowercased. Null when malformed. */
export function toCanonicalReceiver(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0 || s.length > PAYPAL_RECEIVER_MAX_LEN) return null;
  if (EVM_ADDRESS_PATTERN.test(s)) return null;
  if (s.includes("@")) {
    if (!EMAIL_PATTERN.test(s)) return null;
    return s.toLowerCase();
  }
  if (!PAYER_ID_PATTERN.test(s)) return null;
  return s.toLowerCase();
}

/** Alias used by the digest module and engine. */
export function normalizePayPalReceiver(v: string): string {
  return v.trim().toLowerCase();
}

export function validatePayPalReceiver(v: unknown): PayPalReason[] {
  if (!isWellFormedPayPalReceiver(v))
    return [reason("INVALID_RECEIVER", "receiver must be a valid PayPal email or payer-id")];
  return [];
}

// ---------------------------------------------------------------------------
// Amount validation — bigint minor units (cents) only, never floating point
// ---------------------------------------------------------------------------

export function validatePayPalAmountMinor(v: unknown): PayPalReason[] {
  if (typeof v !== "bigint")
    return [reason("INVALID_AMOUNT", "amountMinor must be a bigint in integer cents")];
  if (v <= 0n) return [reason("INVALID_AMOUNT", "amountMinor must be greater than zero")];
  if (v > PAYPAL_MAX_UINT256) return [reason("INVALID_AMOUNT", "amountMinor exceeds uint256")];
  return [];
}

/**
 * Strict decimal USD string → minor-unit (cents) bigint parser.
 * Rejects: signs, scientific notation, empty parts, >2 decimals, malformed.
 * Never rounds: excess precision is an error, not a rounding event.
 */
export function parseDecimalUsdToMinor(input: unknown): bigint {
  if (typeof input !== "string") throw new Error("usd amount must be a decimal string");
  if (input.length === 0 || input.length > 64) throw new Error("usd amount malformed");
  if (!/^\d+(\.\d+)?$/.test(input)) throw new Error("usd amount malformed");
  const parts = input.split(".") as [string, string?];
  const whole = parts[0] as string;
  const fraction = parts[1] ?? "";
  if (whole === "") throw new Error("usd amount malformed");
  if (fraction.length > 2) throw new Error("usd amount exceeds 2 decimal places");
  const padded = fraction.padEnd(2, "0");
  const minor = BigInt(whole) * USD_MINOR_PER_UNIT + (padded === "" ? 0n : BigInt(padded));
  if (minor <= 0n) throw new Error("usd amount must be greater than zero");
  if (minor > PAYPAL_MAX_UINT256) throw new Error("usd amount exceeds uint256");
  return minor;
}

// ---------------------------------------------------------------------------
// Config validation — fail closed, never silently correct
// ---------------------------------------------------------------------------

export function validatePayPalConfig(v: unknown): PayPalReason[] {
  const out: PayPalReason[] = [];
  if (!isPlainObject(v)) return [reason("INVALID_CONFIG", "config must be an object")];
  const c = v as Record<string, unknown>;

  // currency
  if (c["currency"] !== "USD")
    out.push(reason("INVALID_CONFIG", "currency must be USD"));

  // maxPerPaymentMinor: bigint in (0, uint256], AND at or below the absolute
  // $10.00 ceiling. A configuration permitting more is rejected outright.
  if (
    typeof c["maxPerPaymentMinor"] !== "bigint" ||
    (c["maxPerPaymentMinor"] as bigint) <= 0n ||
    (c["maxPerPaymentMinor"] as bigint) > PAYPAL_MAX_UINT256
  )
    out.push(reason("INVALID_CONFIG", "maxPerPaymentMinor must be a bigint in (0, uint256]"));
  else if ((c["maxPerPaymentMinor"] as bigint) > PAYPAL_ABSOLUTE_MAX_MINOR)
    out.push(reason("INVALID_CONFIG", "maxPerPaymentMinor must not exceed the absolute $10.00 ceiling"));

  // requireHumanApproval
  if (typeof c["requireHumanApproval"] !== "boolean")
    out.push(reason("INVALID_CONFIG", "requireHumanApproval must be a boolean"));

  // allowedReceivers
  if (!Array.isArray(c["allowedReceivers"]) || c["allowedReceivers"].length === 0) {
    out.push(reason("INVALID_CONFIG", "allowedReceivers must be a non-empty array"));
  } else {
    const seen = new Set<string>();
    for (const entry of c["allowedReceivers"] as unknown[]) {
      if (!isWellFormedPayPalReceiver(entry)) {
        out.push(reason("INVALID_CONFIG", "allowedReceivers contains a malformed receiver"));
        break;
      }
      const key = (entry as string).trim().toLowerCase();
      if (seen.has(key)) {
        out.push(reason("INVALID_CONFIG", "allowedReceivers contains a duplicate receiver"));
        break;
      }
      seen.add(key);
    }
  }
  return out;
}

/** Validate evaluation context. Returns reasons (INVALID_REQUEST) + parsed values. */
export function parsePayPalContext(v: unknown): {
  reasons: PayPalReason[];
  now: number;
  approval: boolean;
} {
  if (!isPlainObject(v))
    return { reasons: [reason("INVALID_REQUEST", "context must be an object")], now: 0, approval: false };
  const c = v as Record<string, unknown>;
  const reasons: PayPalReason[] = [];
  let now = 0;
  if (typeof c["now"] !== "number" || !Number.isInteger(c["now"]) || !Number.isFinite(c["now"]) || (c["now"] as number) < 0) {
    reasons.push(reason("INVALID_REQUEST", "context.now must be a non-negative integer unix timestamp"));
  } else {
    now = c["now"] as number;
  }
  let approval = false;
  if (typeof c["humanApprovalVerified"] !== "boolean") {
    reasons.push(reason("INVALID_REQUEST", "context.humanApprovalVerified must be a boolean"));
  } else {
    approval = c["humanApprovalVerified"] as boolean;
  }
  return { reasons, now, approval };
}
