import { describe, expect, it } from "vitest";
import { explainPaymentRecord, explainPolicyDecision } from "../../src/paypal/explanation.js";
import { evaluatePayPalPolicy } from "../../src/paypal/engine.js";
import type {
  PayPalIntent,
  PayPalLifecycleState,
  PayPalPaymentRecord,
  PayPalPolicyConfig,
} from "../../src/paypal/types.js";

const POLICY: PayPalPolicyConfig = {
  allowedReceivers: ["merchant@example.com"],
  maxPerPaymentMinor: 1000n,
  currency: "USD",
  requireHumanApproval: true,
};

function intent(amountMinor: bigint): PayPalIntent {
  return {
    requestId: "req-explain-1",
    receiver: "merchant@example.com",
    amountMinor,
    currency: "USD",
    purpose: "hosting",
    nonce: "nonce-explain-1",
    expiresAt: 2_000,
  };
}

function record(
  state: PayPalLifecycleState,
  overrides: Partial<PayPalPaymentRecord> = {},
): PayPalPaymentRecord {
  return {
    requestId: "req-explain-1",
    receiver: "merchant@example.com",
    amountMinor: 500n,
    currency: "USD",
    purpose: "hosting",
    nonce: "nonce-explain-1",
    expiresAt: 2_000,
    state,
    policyDigest: "0x" + "11".repeat(32),
    paymentDigest: "0x" + "22".repeat(32),
    approvalBinding:
      state === "RESERVED" || state === "ORDER_CREATED"
        ? null
        : {
            paymentDigest: "0x" + "22".repeat(32),
            policyDigest: "0x" + "11".repeat(32),
            requestId: "req-explain-1",
            operatorId: "operator-test",
            verifiedAt: 1_500,
          },
    lastOperator: "operator-test",
    lastTransitionedAt: 1_500,
    createdAt: 1_000,
    captureId: state === "CAPTURED" ? "CAPTURE-1" : null,
    providerOrderId: state === "RESERVED" ? null : "ORDER-1",
    ...overrides,
  };
}

describe("PayPal transaction explanations", () => {
  it("explains a policy rejection with the requested amount and limit", () => {
    const paymentIntent = intent(1500n);
    const decision = evaluatePayPalPolicy(paymentIntent, POLICY, {
      now: 1000,
      humanApprovalVerified: false,
    });
    const explanation = explainPolicyDecision(paymentIntent, POLICY, decision, {
      now: 1000,
      providerMode: "sandbox",
      simulated: false,
    });
    expect(explanation.code).toBe("REJECTED");
    expect(explanation.summary).toContain("$15.00");
    expect(explanation.summary).toContain("$10.00");
    expect(explanation.details.some((line) => line.includes("EXCEEDS_LIMIT"))).toBe(true);
    expect(explanation.authorization.captureVerified).toBe(false);
  });

  it("distinguishes policy permission from missing operator approval", () => {
    const paymentIntent = intent(500n);
    const decision = evaluatePayPalPolicy(paymentIntent, POLICY, {
      now: 1000,
      humanApprovalVerified: false,
    });
    const explanation = explainPolicyDecision(paymentIntent, POLICY, decision, {
      now: 1000,
      providerMode: "sandbox",
      simulated: false,
    });
    expect(explanation.code).toBe("REQUIRES_APPROVAL");
    expect(explanation.authorization.policyAllowed).toBe(true);
    expect(explanation.authorization.operatorApprovalRecorded).toBe(false);
    expect(explanation.nextStep).toMatch(/operator approval/i);
  });

  it("does not claim success without a verified capture reference", () => {
    const missingEvidence = explainPaymentRecord(
      record("CAPTURED", { captureId: null }),
      POLICY,
      { now: 1_600, providerMode: "sandbox", simulated: false },
    );
    expect(missingEvidence.code).toBe("UNKNOWN");
    expect(missingEvidence.authorization.captureVerified).toBe(false);
    expect(missingEvidence.summary).not.toMatch(/verified by PayPal/i);
  });

  it("reports verified sandbox capture and labels simulation honestly", () => {
    const sandbox = explainPaymentRecord(record("CAPTURED"), POLICY, {
      now: 1_600,
      providerMode: "sandbox",
      simulated: false,
    });
    expect(sandbox.code).toBe("CAPTURED");
    expect(sandbox.authorization.captureVerified).toBe(true);
    expect(sandbox.summary).toContain("CAPTURE-1");
    expect(sandbox.summary).not.toContain("Simulation mode");

    const mock = explainPaymentRecord(record("CAPTURED"), POLICY, {
      now: 1_600,
      providerMode: "mock",
      simulated: true,
    });
    expect(mock.summary).toContain("Simulation mode");
    expect(mock.provider.simulated).toBe(true);
  });

  it("never describes UNKNOWN as successful", () => {
    const explanation = explainPaymentRecord(record("UNKNOWN"), POLICY, {
      now: 1_600,
      providerMode: "sandbox",
      simulated: false,
    });
    expect(explanation.code).toBe("UNKNOWN");
    expect(explanation.summary).toMatch(/must not be treated as successful/i);
    expect(explanation.authorization.captureVerified).toBe(false);
    expect(explanation.nextStep).toMatch(/do not retry/i);
  });
});
