import { describe, expect, it } from "vitest";
import { canonicalPayPalReceivers, computePayPalPolicyDigest } from "../../src/paypal/digest.js";
import type { PayPalPolicyConfig } from "../../src/paypal/types.js";

function policy(overrides: Partial<PayPalPolicyConfig> = {}): PayPalPolicyConfig {
  return {
    allowedReceivers: ["merchant@example.com"],
    maxPerPaymentMinor: 1000n,
    currency: "USD",
    requireHumanApproval: true,
    ...overrides,
  };
}

describe("paypal policy digest", () => {
  it("is deterministic for identical policy", () => {
    expect(computePayPalPolicyDigest(policy())).toBe(computePayPalPolicyDigest(policy()));
  });

  it("is a 32-byte hex value", () => {
    const d = computePayPalPolicyDigest(policy());
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is invariant to allowlist order and casing", () => {
    const a = policy({ allowedReceivers: ["b@example.com", "a@example.com"] });
    const b = policy({ allowedReceivers: ["A@EXAMPLE.COM", "B@example.com"] });
    expect(computePayPalPolicyDigest(a)).toBe(computePayPalPolicyDigest(b));
    expect(canonicalPayPalReceivers(["B@example.com", "a@example.com"])).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("changes when any authorization-relevant field changes", () => {
    const base = computePayPalPolicyDigest(policy());
    expect(computePayPalPolicyDigest(policy({ maxPerPaymentMinor: 999n }))).not.toBe(base);
    expect(computePayPalPolicyDigest(policy({ requireHumanApproval: false }))).not.toBe(base);
    expect(computePayPalPolicyDigest(policy({ allowedReceivers: ["other@example.com"] }))).not.toBe(base);
    expect(computePayPalPolicyDigest(policy({ currency: "EUR" as unknown as "USD" }))).not.toBe(base);
  });
});
