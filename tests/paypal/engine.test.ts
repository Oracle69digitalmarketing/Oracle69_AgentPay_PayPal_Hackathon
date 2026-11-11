import { describe, expect, it } from "vitest";
import { evaluatePayPalPolicy } from "../../src/paypal/engine.js";
import type { PayPalIntent, PayPalPolicyConfig } from "../../src/paypal/types.js";

const RECEIVER = "merchant@example.com";
const NOW = 1_700_000_000;

function config(overrides: Partial<PayPalPolicyConfig> = {}): PayPalPolicyConfig {
  return {
    allowedReceivers: [RECEIVER],
    maxPerPaymentMinor: 1000n,
    currency: "USD",
    requireHumanApproval: true,
    ...overrides,
  };
}

function intent(overrides: Partial<PayPalIntent> = {}): PayPalIntent {
  return {
    requestId: "req-001",
    receiver: RECEIVER,
    amountMinor: 999n,
    currency: "USD",
    purpose: "hackathon demo",
    nonce: "nonce-001",
    expiresAt: NOW + 3600,
    ...overrides,
  };
}

describe("paypal policy engine", () => {
  it("allows an allowlisted receiver below the limit when approval verified", () => {
    const d = evaluatePayPalPolicy(intent(), config(), { now: NOW, humanApprovalVerified: true });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.currency).toBe("USD");
      expect(d.requiresApproval).toBe(true);
      expect(d.approvalVerified).toBe(true);
    }
  });

  it("allows when approval not required and not verified", () => {
    const d = evaluatePayPalPolicy(
      intent(),
      config({ requireHumanApproval: false }),
      { now: NOW, humanApprovalVerified: false },
    );
    expect(d.allowed).toBe(true);
  });

  it("rejects with MISSING_APPROVAL when approval required but not verified", () => {
    const d = evaluatePayPalPolicy(intent(), config(), { now: NOW, humanApprovalVerified: false });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reasons.map((r) => r.code)).toContain("MISSING_APPROVAL");
  });

  it("boundary: 999 and 1000 cents allowed, 1001 rejected even at max config", () => {
    const ok999 = evaluatePayPalPolicy(intent({ amountMinor: 999n }), config(), {
      now: NOW,
      humanApprovalVerified: true,
    });
    expect(ok999.allowed).toBe(true);
    const ok1000 = evaluatePayPalPolicy(intent({ amountMinor: 1000n }), config(), {
      now: NOW,
      humanApprovalVerified: true,
    });
    expect(ok1000.allowed).toBe(true);
    const over = evaluatePayPalPolicy(intent({ amountMinor: 1001n }), config(), {
      now: NOW,
      humanApprovalVerified: true,
    });
    expect(over.allowed).toBe(false);
    if (!over.allowed) expect(over.reasons.map((r) => r.code)).toContain("EXCEEDS_LIMIT");
  });

  it("rejects unapproved receivers within the limit", () => {
    const d = evaluatePayPalPolicy(intent({ receiver: "other@example.com" }), config(), {
      now: NOW,
      humanApprovalVerified: true,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reasons.map((r) => r.code)).toContain("NOT_ALLOWLISTED");
  });

  it("allowlist comparison is case-insensitive", () => {
    const d = evaluatePayPalPolicy(intent({ receiver: "MERCHANT@Example.COM" }), config(), {
      now: NOW,
      humanApprovalVerified: true,
    });
    expect(d.allowed).toBe(true);
  });

  it("rejects expired requests including now === expiresAt", () => {
    const expired = evaluatePayPalPolicy(intent({ expiresAt: NOW - 1 }), config(), {
      now: NOW,
      humanApprovalVerified: true,
    });
    expect(expired.allowed).toBe(false);
    if (!expired.allowed) expect(expired.reasons.map((r) => r.code)).toContain("EXPIRED_REQUEST");
    const edge = evaluatePayPalPolicy(intent({ expiresAt: NOW }), config(), {
      now: NOW,
      humanApprovalVerified: true,
    });
    expect(edge.allowed).toBe(false);
    if (!edge.allowed) expect(edge.reasons.map((r) => r.code)).toContain("EXPIRED_REQUEST");
    const fresh = evaluatePayPalPolicy(intent({ expiresAt: NOW + 1 }), config(), {
      now: NOW,
      humanApprovalVerified: true,
    });
    expect(fresh.allowed).toBe(true);
  });

  it("rejects wrong currency, zero/negative amounts, non-bigint amounts", () => {
    const wrong = evaluatePayPalPolicy(intent({ currency: "EUR" as unknown as "USD" }), config(), {
      now: NOW,
      humanApprovalVerified: true,
    });
    expect(wrong.allowed).toBe(false);
    if (!wrong.allowed) expect(wrong.reasons.map((r) => r.code)).toContain("INVALID_CURRENCY");
    for (const amount of [0n, -100n]) {
      const d = evaluatePayPalPolicy(intent({ amountMinor: amount }), config(), {
        now: NOW,
        humanApprovalVerified: true,
      });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reasons.map((r) => r.code)).toContain("INVALID_AMOUNT");
    }
    const nonBigint = evaluatePayPalPolicy(
      { ...intent(), amountMinor: 999 } as unknown as PayPalIntent,
      config(),
      { now: NOW, humanApprovalVerified: true },
    );
    expect(nonBigint.allowed).toBe(false);
    if (!nonBigint.allowed) expect(nonBigint.reasons.map((r) => r.code)).toContain("INVALID_AMOUNT");
  });

  it("verified approval never overrides amount/receiver/currency/expiry violations", () => {
    const bad = intent({ receiver: "other@example.com", amountMinor: 5000n, expiresAt: NOW - 10 });
    const d = evaluatePayPalPolicy(bad, config(), { now: NOW, humanApprovalVerified: true });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reasons.map((r) => r.code)).not.toContain("MISSING_APPROVAL");
      expect(d.reasons.length).toBeGreaterThan(1);
    }
  });

  it("returns deterministic reason ordering for simultaneous violations", () => {
    const bad = {
      requestId: "",
      receiver: "bad-receiver",
      amountMinor: 0n,
      currency: "EUR",
      purpose: "",
      nonce: "",
      expiresAt: NOW - 5,
    } as unknown as PayPalIntent;
    const a = evaluatePayPalPolicy(bad, config(), { now: NOW, humanApprovalVerified: false });
    const b = evaluatePayPalPolicy(bad, config(), { now: NOW, humanApprovalVerified: false });
    expect(a).toEqual(b);
    if (!a.allowed) {
      const codes = a.reasons.map((r) => r.code);
      expect([...codes].sort()).not.toEqual(codes); // order is semantic, not alphabetical
      expect(codes[0]).toBe("INVALID_REQUEST");
    }
  });

  it("mutating the intent after evaluation cannot alter the returned decision", () => {
    const input = intent();
    const d = evaluatePayPalPolicy(input, config(), { now: NOW, humanApprovalVerified: true });
    expect(d.allowed).toBe(true);
    input.amountMinor = 999999n;
    input.receiver = "attacker@example.com";
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.currency).toBe("USD");
      expect(d.approvalVerified).toBe(true);
    }
    const d2 = evaluatePayPalPolicy(input, config(), { now: NOW, humanApprovalVerified: true });
    expect(d2.allowed).toBe(false);
  });

  it("malformed intent root and config fail closed", () => {
    expect(evaluatePayPalPolicy(null, config(), { now: NOW, humanApprovalVerified: true }).allowed).toBe(false);
    expect(evaluatePayPalPolicy([], config(), { now: NOW, humanApprovalVerified: true }).allowed).toBe(false);
    expect(
      evaluatePayPalPolicy(intent(), { ...config(), maxPerPaymentMinor: 1001n }, { now: NOW, humanApprovalVerified: true })
        .allowed,
    ).toBe(false);
  });
});
