import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPayPalPolicyFromEnv,
  createPayPalProviderFromEnv,
} from "../../server/paypal-server.js";
import { validatePayPalConfig } from "../../src/paypal/validation.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function clearPayPalEnv(): void {
  for (const name of [
    "PAYPAL_MODE",
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_MERCHANT_ID",
    "PAYPAL_BASE_URL",
    "PAYPAL_ALLOWED_RECEIVERS",
    "PAYPAL_MAX_MINOR",
  ]) {
    vi.stubEnv(name, "");
  }
}

describe("PayPal environment configuration", () => {
  it("refuses explicit Sandbox mode with missing credentials instead of falling back to mock", () => {
    clearPayPalEnv();
    vi.stubEnv("PAYPAL_MODE", "sandbox");
    expect(() => createPayPalProviderFromEnv()).toThrow(
      /requires PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_MERCHANT_ID/,
    );
  });

  it("rejects an unknown PayPal mode", () => {
    clearPayPalEnv();
    vi.stubEnv("PAYPAL_MODE", "live");
    expect(() => createPayPalProviderFromEnv()).toThrow(/must be either sandbox or mock/);
  });

  it("uses mock only when mode is omitted and credentials are absent", () => {
    clearPayPalEnv();
    expect(createPayPalProviderFromEnv().mode).toBe("mock");
  });

  it("selects Sandbox when explicitly requested with complete fake configuration", () => {
    clearPayPalEnv();
    vi.stubEnv("PAYPAL_MODE", " SANDBOX ");
    vi.stubEnv("PAYPAL_CLIENT_ID", "test-client-id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("PAYPAL_MERCHANT_ID", "TEST-MERCHANT");
    vi.stubEnv("PAYPAL_BASE_URL", "https://api-m.sandbox.paypal.com");
    const provider = createPayPalProviderFromEnv();
    expect(provider.mode).toBe("sandbox");
    expect(provider.isMock).toBe(false);
  });

  it("preserves the $10 ceiling as fail-closed policy configuration", () => {
    clearPayPalEnv();
    vi.stubEnv("PAYPAL_MAX_MINOR", "1001");
    const configured = createPayPalPolicyFromEnv();
    expect(configured.maxPerPaymentMinor).toBe(1001n);
    expect(validatePayPalConfig(configured).some((reason) => reason.code === "INVALID_CONFIG")).toBe(true);
  });

  it("defaults malformed limits to the documented $10 ceiling", () => {
    clearPayPalEnv();
    vi.stubEnv("PAYPAL_MAX_MINOR", "not-a-number");
    expect(createPayPalPolicyFromEnv().maxPerPaymentMinor).toBe(1000n);
  });
});
