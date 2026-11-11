import { describe, expect, it } from "vitest";
import {
  PAYPAL_ABSOLUTE_MAX_MINOR,
  USD_MINOR_PER_UNIT,
} from "../../src/paypal/types.js";
import {
  isWellFormedPayPalReceiver,
  parseDecimalUsdToMinor,
  toCanonicalReceiver,
  validatePayPalAmountMinor,
  validatePayPalConfig,
  validatePayPalCurrency,
  validatePayPalReceiver,
} from "../../src/paypal/validation.js";

describe("paypal validation", () => {
  it("parses whole and fractional USD strings to exact cents", () => {
    expect(parseDecimalUsdToMinor("10.00")).toBe(1000n);
    expect(parseDecimalUsdToMinor("10")).toBe(1000n);
    expect(parseDecimalUsdToMinor("0.01")).toBe(1n);
    expect(parseDecimalUsdToMinor("9.99")).toBe(999n);
    expect(parseDecimalUsdToMinor("0.1")).toBe(10n);
    expect(USD_MINOR_PER_UNIT).toBe(100n);
  });

  it("rejects signs, scientific notation, excess precision, malformed", () => {
    for (const bad of ["-1.00", "+1.00", "1e2", "1E2", "10.001", "10.000", "", "  ", "abc", "$10", "10.", ".99", "10..00", "0.00", "0", "00.00"]) {
      expect(() => parseDecimalUsdToMinor(bad), bad).toThrow();
    }
  });

  it("rejects non-bigint and out-of-range amounts", () => {
    expect(validatePayPalAmountMinor(100)).not.toHaveLength(0);
    expect(validatePayPalAmountMinor("1000")).not.toHaveLength(0);
    expect(validatePayPalAmountMinor(0n).map((r) => r.code)).toContain("INVALID_AMOUNT");
    expect(validatePayPalAmountMinor(-5n).map((r) => r.code)).toContain("INVALID_AMOUNT");
    expect(validatePayPalAmountMinor(1000n)).toHaveLength(0);
  });

  it("accepts email and payer-id receivers, rejects EVM-shaped and malformed", () => {
    expect(isWellFormedPayPalReceiver("merchant@example.com")).toBe(true);
    expect(isWellFormedPayPalReceiver("MERCHANT@Example.COM")).toBe(true);
    expect(isWellFormedPayPalReceiver("receiver_01-abc")).toBe(true);
    expect(isWellFormedPayPalReceiver("0x5cf66568b51b308BCf13319F5e84cff28104E1aF")).toBe(false);
    expect(isWellFormedPayPalReceiver("ab")).toBe(false);
    expect(isWellFormedPayPalReceiver("bad receiver!")).toBe(false);
    expect(isWellFormedPayPalReceiver("a@b")).toBe(false);
    expect(isWellFormedPayPalReceiver("")).toBe(false);
    expect(validatePayPalReceiver("merchant@example.com")).toHaveLength(0);
    expect(validatePayPalReceiver("0xabc")[0]?.code).toBe("INVALID_RECEIVER");
  });

  it("canonicalizes receivers case-insensitively", () => {
    expect(toCanonicalReceiver("MERCHANT@Example.COM")).toBe("merchant@example.com");
    expect(toCanonicalReceiver("  merchant@example.com  ")).toBe("merchant@example.com");
    expect(toCanonicalReceiver("0xabc")).toBeNull();
  });

  it("rejects non-USD currency", () => {
    expect(validatePayPalCurrency("USD")).toHaveLength(0);
    expect(validatePayPalCurrency("EUR")[0]?.code).toBe("INVALID_CURRENCY");
    expect(validatePayPalCurrency("MON")[0]?.code).toBe("INVALID_CURRENCY");
  });

  it("rejects config above the absolute $10.00 ceiling", () => {
    expect(PAYPAL_ABSOLUTE_MAX_MINOR).toBe(1000n);
    const base = {
      allowedReceivers: ["merchant@example.com"],
      maxPerPaymentMinor: 1000n,
      currency: "USD" as const,
      requireHumanApproval: true,
    };
    expect(validatePayPalConfig(base)).toHaveLength(0);
    const over = { ...base, maxPerPaymentMinor: 1001n };
    const reasons = validatePayPalConfig(over);
    expect(reasons.map((r) => r.code)).toContain("INVALID_CONFIG");
    const malformed = { ...base, maxPerPaymentMinor: 1000 };
    expect(validatePayPalConfig(malformed).map((r) => r.code)).toContain("INVALID_CONFIG");
  });

  it("rejects contradictory config instead of correcting it", () => {
    expect(validatePayPalConfig(null).map((r) => r.code)).toContain("INVALID_CONFIG");
    expect(
      validatePayPalConfig({
        allowedReceivers: [],
        maxPerPaymentMinor: 1000n,
        currency: "USD",
        requireHumanApproval: true,
      }).map((r) => r.code),
    ).toContain("INVALID_CONFIG");
    expect(
      validatePayPalConfig({
        allowedReceivers: ["merchant@example.com", "MERCHANT@example.com"],
        maxPerPaymentMinor: 1000n,
        currency: "USD",
        requireHumanApproval: true,
      }).map((r) => r.code),
    ).toContain("INVALID_CONFIG");
    expect(
      validatePayPalConfig({
        allowedReceivers: ["merchant@example.com"],
        maxPerPaymentMinor: 1000n,
        currency: "EUR",
        requireHumanApproval: true,
      }).map((r) => r.code),
    ).toContain("INVALID_CONFIG");
  });
});
