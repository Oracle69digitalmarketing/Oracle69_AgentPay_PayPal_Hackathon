/**
 * PayPal domain types — Oracle69 AgentPay (PayPal MVP, Phase 4A).
 *
 * SCOPE:
 * - USD only. Amounts are integer minor units (cents) as bigint — never floats.
 * - This module is intentionally independent of src/policy, src/auth, and
 *   src/execution. It MUST NOT import Monad concepts (MON, wei, chainId,
 *   EVM addresses, EIP-712, RPC ports, signers). Isolation is structural.
 *
 * SECURITY BOUNDARY (Phase 4A):
 * - `evaluatePayPalPolicy` decides whether a PayPal intent SATISFIES POLICY.
 * - It does NOT authenticate human approval, create orders, or capture funds.
 * - `{ allowed: true }` means "policy satisfied, pending complete
 *   authorization" — it must NEVER be treated as executable on its own.
 *   Order creation and capture arrive in later phases and must re-check
 *   policy before any PayPal call.
 */

/** Only supported currency in the PayPal MVP. */
export type PayPalCurrency = "USD";

/** Minor units per USD unit: 100 cents = $1.00. */
export const USD_MINOR_PER_UNIT = 100n;

/** Demo limit: $10.00 expressed in cents. */
export const PAYPAL_DEMO_MAX_MINOR = 1000n;

/**
 * ABSOLUTE hard ceiling (PayPal safeguard): no policy configuration may permit,
 * and no payment may carry, more than $10.00 per transaction. Enforced at the
 * config-validation boundary and re-checked at the decision boundary.
 * Exact bigint cents; never floats. Independent of the Monad 1 MON ceiling.
 */
export const PAYPAL_ABSOLUTE_MAX_MINOR = 1000n;

/** Max uint256 value (inclusive upper bound for amounts). */
export const PAYPAL_MAX_UINT256 = (1n << 256n) - 1n;

/** Structured PayPal payment intent supplied to the policy engine. */
export interface PayPalIntent {
  requestId: string;
  /** Allowlisted PayPal receiver (email or payer-id). Never an EVM address. */
  receiver: string;
  /** Integer cents as bigint. $10.00 === 1000n. */
  amountMinor: bigint;
  currency: PayPalCurrency;
  purpose: string;
  nonce: string;
  /** Unix timestamp in seconds. The request is valid while `now < expiresAt`. */
  expiresAt: number;
}

/** PayPal policy configuration bounding payment authority. */
export interface PayPalPolicyConfig {
  allowedReceivers: string[];
  maxPerPaymentMinor: bigint;
  currency: PayPalCurrency;
  requireHumanApproval: boolean;
}

/**
 * Evaluation context.
 * - `now`: unix seconds used for expiry checks (injected for reproducibility).
 * - `humanApprovalVerified`: whether a LATER authorization mechanism has
 *   verified human approval for the EXACT intent. The engine never
 *   authenticates approval itself; it only reads this flag. Client-supplied
 *   booleans must never be treated as authenticated — the server must set
 *   this flag only from its own verified approval state (not yet implemented).
 */
export interface PayPalContext {
  now: number;
  humanApprovalVerified: boolean;
}

/** Stable machine-readable rejection codes. Order matters — see PAYPAL_REASON_ORDER. */
export type PayPalRejectionCode =
  | "INVALID_REQUEST"
  | "INVALID_RECEIVER"
  | "INVALID_AMOUNT"
  | "INVALID_CURRENCY"
  | "NOT_ALLOWLISTED"
  | "EXCEEDS_LIMIT"
  | "EXPIRED_REQUEST"
  | "MISSING_APPROVAL"
  | "INVALID_CONFIG";

export interface PayPalReason {
  code: PayPalRejectionCode;
  message: string;
}

/**
 * Deterministic ordering of rejection codes.
 * Reasons are ALWAYS sorted by this order (then by message) so the same
 * input produces byte-identical output regardless of object insertion order.
 */
export const PAYPAL_REASON_ORDER: readonly PayPalRejectionCode[] = [
  "INVALID_CONFIG",
  "INVALID_REQUEST",
  "INVALID_CURRENCY",
  "INVALID_RECEIVER",
  "INVALID_AMOUNT",
  "NOT_ALLOWLISTED",
  "EXCEEDS_LIMIT",
  "EXPIRED_REQUEST",
  "MISSING_APPROVAL",
];

export interface PayPalAllowed {
  allowed: true;
  /** Echoes config.requireHumanApproval: true means a verified approval was required (and present). */
  requiresApproval: boolean;
  approvalVerified: boolean;
  currency: PayPalCurrency;
}

export interface PayPalRejected {
  allowed: false;
  reasons: PayPalReason[];
}

export type PayPalDecision = PayPalAllowed | PayPalRejected;

/** PayPal payment lifecycle state. */
export type PayPalLifecycleState =
  | "RESERVED"
  | "ORDER_CREATED"
  | "APPROVED"
  | "CAPTURING"
  | "CAPTURED"
  | "UNKNOWN"
  | "FAILED"
  | "VOIDED"
  | "STALE";

/** Permitted outgoing transitions from each lifecycle state. */
export const PayPalLifecycleTransitions: Readonly<Record<PayPalLifecycleState, PayPalLifecycleState[]>> = {
  RESERVED: ["ORDER_CREATED"],
  ORDER_CREATED: ["APPROVED", "FAILED", "VOIDED"],
  APPROVED: ["CAPTURING", "FAILED", "VOIDED"],
  CAPTURING: ["CAPTURED", "UNKNOWN", "FAILED", "VOIDED"],
  CAPTURED: [],
  UNKNOWN: ["FAILED"],
  FAILED: [],
  VOIDED: [],
  STALE: ["RESERVED"],
};

/** Incoming transition validation: only transitions listed above are permitted. */
export function isValidTransition(from: PayPalLifecycleState, to: PayPalLifecycleState): boolean {
  const allowed = PayPalLifecycleTransitions[from];
  if (!allowed || allowed.length === 0) return false;
  return allowed.includes(to);
}

/** Persistent payment record stored in SQLite. */
export interface PayPalPaymentRecord {
  /** Unique request ID (also PRIMARY KEY). */
  requestId: string;
  /** PayPal receiver (canonical trimmed/lowercased). */
  receiver: string;
  /** Amount in minor units (cents), bigint. */
  amountMinor: bigint;
  /** Currency — always "USD". */
  currency: PayPalCurrency;
  /** Purpose from the original intent. */
  purpose: string;
  /** Nonce for replay protection. */
  nonce: string;
  /** Expiry timestamp (unix seconds). Request expired when now >= expiresAt. */
  expiresAt: number;
  /** Lifecycle state machine. */
  state: PayPalLifecycleState;
  /** Policy digest at reservation time (binds future state transitions). */
  policyDigest: string;
  /** Payment-intent digest at reservation time. */
  paymentDigest: string;
  /** Human-approval binding reference (populated when state → APPROVED). */
  approvalBinding: PayPalApprovalBinding | null;
  /** Creator/operator identity that last transitioned the state. */
  lastOperator: string;
  /** Timestamp when state was last transitioned (unix seconds). */
  lastTransitionedAt: number;
  /** Created-at timestamp (unix seconds, immutable). */
  createdAt: number;
  /** Optional capture ID from PayPal when capture completes. */
  captureId: string | null;
  /** Optional provider order ID from PayPal. */
  providerOrderId: string | null;
}

/** Binding that ties a human approval to the payment-intent and policy digests. */
export interface PayPalApprovalBinding {
  /** The payment-intent digest at the time of approval. */
  paymentDigest: string;
  /** The policy digest at the time of approval. */
  policyDigest: string;
  /** The request ID the approval is bound to. */
  requestId: string;
  /** The authenticated operator identity. */
  operatorId: string;
  /** unix seconds when approval was verified. */
  verifiedAt: number;
}


/** Audit event types for the immutable PayPal payment timeline. */
export type PayPalAuditEventType =
  | "PAYMENT_INTENT_CREATED"
  | "POLICY_EVALUATED"
  | "PAYMENT_RESERVED"
  | "PAYPAL_ORDER_CREATED"
  | "BUYER_APPROVAL_VERIFIED"
  | "BUYER_APPROVAL_FAILED"
  | "OPERATOR_APPROVAL_RECORDED"
  | "CAPTURE_INITIATED"
  | "CAPTURE_VERIFIED"
  | "CAPTURE_UNKNOWN"
  | "PAYMENT_FAILED"
  | "PAYMENT_VOIDED"
  | "ORDER_CREATION_FAILED"
  | "DUPLICATE_CAPTURE_REJECTED"
  | "STATE_CHANGED";

/** A single append-only audit event. Events are never updated or deleted. */
export interface PayPalAuditEvent {
  id: number;
  requestId: string;
  eventType: PayPalAuditEventType;
  state: PayPalLifecycleState;
  message: string;
  code: string | null;
  operatorId: string | null;
  providerOrderId: string | null;
  captureId: string | null;
  createdAt: number;
}

/** Input for appending an audit event. */
export interface PayPalAuditInput {
  eventType: PayPalAuditEventType;
  state: PayPalLifecycleState;
  message: string;
  code?: string | undefined;
  operatorId?: string | undefined;
  providerOrderId?: string | undefined;
  captureId?: string | undefined;
}

/** Result of a store claim (reservation) operation. */
export interface PayPalClaimResult {
  ok: true;
  /** The persisted payment record. */
  record: PayPalPaymentRecord;
}
/** Result of a store claim that collided with an existing record. */
export interface PayPalClaimCollision {
  ok: false;
  /** "nonce" or "requestId" that was already consumed. */
  reused: "nonce" | "requestId";
}
/** Result of any store read/write operation. */
export type PayPalStoreResult =
  | PayPalClaimResult
  | PayPalClaimCollision
  | { ok: false; reason: string };
