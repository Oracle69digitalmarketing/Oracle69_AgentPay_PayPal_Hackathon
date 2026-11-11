/**
 * Deterministic human-readable explanations for PayPal payment decisions.
 *
 * This layer is intentionally non-authoritative: it only describes the
 * existing policy decision, persisted lifecycle state, and provider evidence.
 * It cannot mutate state, approve payments, manufacture references, or turn
 * UNKNOWN into CAPTURED.
 */
import { evaluatePayPalPolicy } from "./engine.js";
import type {
  PayPalContext,
  PayPalDecision,
  PayPalIntent,
  PayPalPaymentRecord,
  PayPalPolicyConfig,
  PayPalReason,
} from "./types.js";
import { normalizePayPalReceiver } from "./validation.js";

export type PayPalExplanationCode =
  | "ALLOWED"
  | "REJECTED"
  | "REQUIRES_APPROVAL"
  | "PENDING"
  | "CAPTURED"
  | "FAILED"
  | "UNKNOWN"
  | "VOIDED"
  | "STALE";

export interface PayPalExplanation {
  code: PayPalExplanationCode;
  summary: string;
  nextStep: string;
  details: string[];
  policy: {
    allowed: boolean;
    reasons: PayPalReason[];
  };
  authorization: {
    policyAllowed: boolean;
    buyerApprovalConfirmed: boolean;
    operatorApprovalRecorded: boolean;
    captureVerified: boolean;
  };
  provider: {
    mode: "sandbox" | "mock";
    simulated: boolean;
    execution: string;
  };
}

export interface ExplanationContext {
  now: number;
  providerMode: "sandbox" | "mock";
  simulated: boolean;
}

function money(amountMinor: bigint): string {
  const whole = amountMinor / 100n;
  const cents = amountMinor % 100n;
  return `$${whole.toString()}.${cents.toString().padStart(2, "0")}`;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function allowlisted(receiver: string, policy: PayPalPolicyConfig): boolean {
  const target = normalizePayPalReceiver(receiver);
  return policy.allowedReceivers.some((candidate) => normalizePayPalReceiver(candidate) === target);
}

function baseDetails(intent: PayPalIntent, policy: PayPalPolicyConfig, ctx: ExplanationContext): string[] {
  const merchantDecision = allowlisted(intent.receiver, policy)
    ? "recipient is on the merchant allowlist"
    : "recipient is NOT on the merchant allowlist";
  const limitDecision =
    intent.amountMinor <= policy.maxPerPaymentMinor
      ? `within the ${money(policy.maxPerPaymentMinor)} per-payment limit`
      : `above the ${money(policy.maxPerPaymentMinor)} per-payment limit`;
  const expiryDecision =
    ctx.now >= intent.expiresAt
      ? `expired at ${iso(intent.expiresAt)}`
      : `valid until ${iso(intent.expiresAt)}`;
  return [
    `Requested ${money(intent.amountMinor)} ${intent.currency} to ${intent.receiver} for ${intent.purpose}.`,
    `Spending policy: ${limitDecision}; ${merchantDecision}; request ${expiryDecision}.`,
    `Operator approval: ${policy.requireHumanApproval ? "required" : "not required"} by policy.`,
  ];
}

function simulatedSuffix(ctx: ExplanationContext): string {
  return ctx.simulated ? " Simulation mode: no real PayPal funds moved." : "";
}

function policyNextStep(decision: PayPalDecision, policy: PayPalPolicyConfig): string {
  if (!decision.allowed) return "Edit the payment request so it satisfies every policy reason, then submit it again.";
  if (policy.requireHumanApproval) return "Record operator approval before any PayPal order creation or capture.";
  return "The policy allows this request; the next server step may create a PayPal order.";
}

/** Explains a pre-execution policy decision. */
export function explainPolicyDecision(
  intent: PayPalIntent,
  policy: PayPalPolicyConfig,
  decision: PayPalDecision,
  ctx: ExplanationContext,
): PayPalExplanation {
  const reasons = decision.allowed ? [] : decision.reasons;
  const onlyApprovalMissing = !decision.allowed && reasons.every((reason) => reason.code === "MISSING_APPROVAL");
  const details = baseDetails(intent, policy, ctx);
  for (const reason of reasons) details.push(`${reason.code}: ${reason.message}`);

  if (onlyApprovalMissing) {
    return {
      code: "REQUIRES_APPROVAL",
      summary:
        "Payment requires approval: the transaction passed deterministic spending checks but has not received the required operator approval." +
        simulatedSuffix(ctx),
      nextStep: "Record operator approval before any PayPal order capture. Buyer approval alone is not operator approval.",
      details,
      policy: { allowed: false, reasons },
      authorization: {
        policyAllowed: true,
        buyerApprovalConfirmed: false,
        operatorApprovalRecorded: false,
        captureVerified: false,
      },
      provider: {
        mode: ctx.providerMode,
        simulated: ctx.simulated,
        execution: "No PayPal order has been created yet.",
      },
    };
  }

  if (!decision.allowed) {
    const first = reasons[0];
    const summary =
      first?.code === "EXCEEDS_LIMIT"
        ? `Payment rejected: the requested amount is ${money(intent.amountMinor)}, but the current transaction limit is ${money(policy.maxPerPaymentMinor)}.`
        : `Payment rejected: ${first?.message ?? "the request did not satisfy the spending policy"}.`;
    return {
      code: "REJECTED",
      summary,
      nextStep: policyNextStep(decision, policy),
      details,
      policy: { allowed: false, reasons },
      authorization: {
        policyAllowed: false,
        buyerApprovalConfirmed: false,
        operatorApprovalRecorded: false,
        captureVerified: false,
      },
      provider: {
        mode: ctx.providerMode,
        simulated: ctx.simulated,
        execution: "No PayPal order was created.",
      },
    };
  }

  const requiresApproval = policy.requireHumanApproval;
  const summary = requiresApproval
    ? "Payment requires approval: the transaction passed deterministic policy checks but has not received the required operator approval."
    : "Payment allowed by policy: all deterministic spending checks passed.";
  return {
    code: requiresApproval ? "REQUIRES_APPROVAL" : "ALLOWED",
    summary: summary + simulatedSuffix(ctx),
    nextStep: policyNextStep(decision, policy),
    details,
    policy: { allowed: true, reasons: [] },
    authorization: {
      policyAllowed: true,
      buyerApprovalConfirmed: false,
      operatorApprovalRecorded: false,
      captureVerified: false,
    },
    provider: {
      mode: ctx.providerMode,
      simulated: ctx.simulated,
      execution: "No PayPal order has been created yet.",
    },
  };
}

function recordIntent(record: PayPalPaymentRecord): PayPalIntent {
  return {
    requestId: record.requestId,
    receiver: record.receiver,
    amountMinor: record.amountMinor,
    currency: record.currency,
    purpose: record.purpose,
    nonce: record.nonce,
    expiresAt: record.expiresAt,
  };
}

function stateSummary(
  record: PayPalPaymentRecord,
  ctx: ExplanationContext,
): { code: PayPalExplanationCode; summary: string; nextStep: string; execution: string } {
  const captureVerified = record.state === "CAPTURED" && typeof record.captureId === "string" && record.captureId.length > 0;
  switch (record.state) {
    case "RESERVED":
      return {
        code: "PENDING",
        summary: "Payment is reserved but no PayPal order has been confirmed yet.",
        nextStep: "Wait for the server to bind a PayPal order. Do not submit a duplicate payment.",
        execution: "The provider has not confirmed order creation.",
      };
    case "ORDER_CREATED":
      return {
        code: "REQUIRES_APPROVAL",
        summary: "PayPal order created; buyer approval and operator confirmation are still required.",
        nextStep: "Approve the payment in PayPal Sandbox, then ask the server to verify the approval.",
        execution: "PayPal order exists, but no buyer-approved capture has occurred.",
      };
    case "APPROVED":
      return {
        code: "PENDING",
        summary: "PayPal buyer approval and operator approval are recorded; capture has not completed.",
        nextStep: "Initiate capture from the backend. Do not describe the payment as paid yet.",
        execution: "Approved, but no verified capture exists.",
      };
    case "CAPTURING":
      return {
        code: "PENDING",
        summary: "Capture is in progress. The outcome is not yet confirmed.",
        nextStep: "Wait for verification. Do not submit another payment.",
        execution: "Capture request sent; awaiting provider evidence.",
      };
    case "CAPTURED":
      if (!captureVerified) {
        return {
          code: "UNKNOWN",
          summary: "Payment is marked CAPTURED but no verified PayPal capture reference is present.",
          nextStep: "Investigate with PayPal before taking any further action.",
          execution: "Capture evidence is missing; success cannot be claimed.",
        };
      }
      return {
        code: "CAPTURED",
        summary: `Payment captured and independently verified by PayPal. Reference: ${record.captureId}.`,
        nextStep: "Payment is complete. Retain the PayPal capture reference for reconciliation.",
        execution: "Verified PayPal capture evidence is recorded.",
      };
    case "FAILED":
      return {
        code: "FAILED",
        summary: "Payment failed. No successful capture is recorded.",
        nextStep: "Review the recorded failure reason. Create a new payment request only if appropriate.",
        execution: "The provider or policy reported a definite failure.",
      };
    case "UNKNOWN":
      return {
        code: "UNKNOWN",
        summary: "Payment outcome is unknown and must not be treated as successful.",
        nextStep: "Do not retry automatically. Reconcile the PayPal order and capture status first.",
        execution: "The provider outcome could not be proven; no CAPTURED record was created.",
      };
    case "VOIDED":
      return {
        code: "VOIDED",
        summary: "Payment was voided or cancelled; no capture occurred.",
        nextStep: "Start a new payment request if the buyer still wants to pay.",
        execution: "The payment is voided.",
      };
    case "STALE":
      return {
        code: "STALE",
        summary: "Payment is stale and no longer authorized for the current policy.",
        nextStep: "Start a new payment request.",
        execution: "No capture is permitted from this stale authorization.",
      };
  }
}

/** Explains the actual persisted state of a payment record. */
export function explainPaymentRecord(
  record: PayPalPaymentRecord,
  policy: PayPalPolicyConfig,
  ctx: ExplanationContext,
): PayPalExplanation {
  const intent = recordIntent(record);
  const context: PayPalContext = {
    now: ctx.now,
    humanApprovalVerified: record.approvalBinding !== null,
  };
  const decision = evaluatePayPalPolicy(intent, policy, context);
  const reasons = decision.allowed ? [] : decision.reasons;
  const details = baseDetails(intent, policy, ctx);
  details.push(`Current lifecycle state: ${record.state}.`);
  if (record.providerOrderId !== null) details.push(`PayPal order ID: ${record.providerOrderId}.`);
  if (record.captureId !== null) details.push(`PayPal capture ID: ${record.captureId}.`);
  if (record.approvalBinding !== null) {
    details.push(`Operator approval recorded at ${iso(record.approvalBinding.verifiedAt)}.`);
  }
  for (const reason of reasons) details.push(`${reason.code}: ${reason.message}`);

  const state = stateSummary(record, ctx);
  const captureVerified = record.state === "CAPTURED" && record.captureId !== null;
  const buyerApprovalConfirmed = record.approvalBinding !== null;
  return {
    code: state.code,
    summary: state.summary + simulatedSuffix(ctx),
    nextStep: state.nextStep,
    details,
    policy: { allowed: decision.allowed, reasons },
    authorization: {
      policyAllowed: decision.allowed,
      buyerApprovalConfirmed,
      operatorApprovalRecorded: record.approvalBinding !== null,
      captureVerified,
    },
    provider: {
      mode: ctx.providerMode,
      simulated: ctx.simulated,
      execution: state.execution,
    },
  };
}
