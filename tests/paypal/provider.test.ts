import { describe, expect, it } from "vitest";
import {
  PayPalProvider,
  findPayPalCapture,
  getOrderApprovalUrl,
  type PayPalConfig,
  type PayPalFetch,
  type PayPalHttpResponse,
} from "../../src/paypal/provider.js";

const CLIENT_ID = "sandbox-client-id";
const CLIENT_SECRET = "sandbox-client-secret";
const TOKEN = "sandbox-access-token";

interface RecordedCall {
  url: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
}

function response(status: number, body: unknown): PayPalHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function config(overrides: Partial<PayPalConfig> = {}): PayPalConfig {
  return {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    baseUrl: "https://api.sandbox.paypal.com",
    merchantId: "MERCHANT-123",
    mode: "sandbox",
    timeoutMs: 1000,
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "ORDER-123",
    status: "CREATED",
    purchase_units: [
      {
        reference_id: "req-001",
        amount: { currency_code: "USD", value: "12.34" },
        payee: { email_address: "merchant@example.com", merchant_id: "MERCHANT-123" },
      },
    ],
    links: [
      { rel: "self", href: "https://api.sandbox.paypal.com/v2/checkout/orders/ORDER-123" },
      { rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123" },
    ],
    ...overrides,
  };
}

function sandboxProvider(
  handler: (call: RecordedCall) => Promise<PayPalHttpResponse>,
  overrides: Partial<PayPalConfig> = {},
): { provider: PayPalProvider; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: PayPalFetch = async (url, init) => {
    const call: RecordedCall = { url };
    if (init !== undefined) call.init = init;
    calls.push(call);
    return handler(call);
  };
  return { provider: new PayPalProvider(config({ fetchImpl, ...overrides })), calls };
}

function withToken(handler: (call: RecordedCall) => Promise<PayPalHttpResponse>) {
  return async (call: RecordedCall): Promise<PayPalHttpResponse> => {
    if (call.url.endsWith("/v1/oauth2/token")) {
      return response(200, { access_token: TOKEN, expires_in: 3600 });
    }
    return handler(call);
  };
}

describe("PayPal provider authentication", () => {
  it("uses Basic client credentials and caches the access token", async () => {
    const { provider, calls } = sandboxProvider(
      withToken(async () => response(200, order())),
    );
    const first = await provider.createOrder("req-001", 1234n, "merchant@example.com");
    expect(first.ok).toBe(true);
    const second = await provider.getOrder("ORDER-123");
    expect(second.ok).toBe(true);

    const tokenCalls = calls.filter((call) => call.url.endsWith("/v1/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
    const tokenCall = tokenCalls[0]!;
    expect(tokenCall.init?.method).toBe("POST");
    expect(tokenCall.init?.headers?.authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    );
    expect(tokenCall.init?.body).toBe("grant_type=client_credentials");

    const apiCall = calls.find((call) => call.url.includes("/v2/checkout/orders"));
    expect(apiCall?.init?.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("fails closed on authentication rejection without leaking credentials", async () => {
    const { provider } = sandboxProvider(async () => response(401, { error: "invalid_client" }));
    const result = await provider.createOrder("req-001", 100n, "merchant@example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_FAILED");
      expect(result.error.ambiguous).toBe(false);
      expect(result.error.message).not.toContain(CLIENT_SECRET);
      expect(result.error.message).not.toContain(CLIENT_ID);
    }
  });

  it("rejects incomplete sandbox configuration", () => {
    expect(() => new PayPalProvider(config({ clientSecret: "" }))).toThrow(/incomplete/i);
    expect(() => new PayPalProvider(config({ baseUrl: "http://api.sandbox.paypal.com" }))).toThrow(/https/i);
  });

  it("refuses Live PayPal endpoints and accepts Sandbox API hosts", () => {
    expect(() => new PayPalProvider(config({ baseUrl: "https://api.paypal.com" }))).toThrow(/Sandbox/i);
    expect(() => new PayPalProvider(config({ baseUrl: "https://api-m.paypal.com" }))).toThrow(/Sandbox/i);
    expect(
      () => new PayPalProvider(config({ baseUrl: "https://api-m.sandbox.paypal.com" })),
    ).not.toThrow();
  });
});

describe("PayPal provider order lifecycle", () => {
  it("creates a real order request with exact amount, receiver, idempotency key, and approval URL", async () => {
    const { provider, calls } = sandboxProvider(withToken(async () => response(201, order())));
    const result = await provider.createOrder("req-001", 1234n, "merchant@example.com");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("sandbox");
      expect(result.data.id).toBe("ORDER-123");
      expect(getOrderApprovalUrl(result.data)).toBe(
        "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123",
      );
      expect(provider.getApprovalUrl(result.data)).toBe(
        "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123",
      );
    }
    const createCall = calls.find((call) => call.url.endsWith("/v2/checkout/orders"));
    expect(createCall?.init?.method).toBe("POST");
    expect(createCall?.init?.headers?.["paypal-request-id"]).toBe("req-001");
    const body = JSON.parse(createCall?.init?.body ?? "{}") as {
      intent: string;
      purchase_units: Array<{
        reference_id: string;
        amount: { currency_code: string; value: string };
        payee: { email_address?: string };
      }>;
    };
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0]?.reference_id).toBe("req-001");
    expect(body.purchase_units[0]?.amount).toEqual({ currency_code: "USD", value: "12.34" });
    expect(body.purchase_units[0]?.payee.email_address).toBe("merchant@example.com");
  });

  it("retrieves an order by encoded order id", async () => {
    const { provider, calls } = sandboxProvider(
      withToken(async () => response(200, order({ status: "APPROVED" }))),
    );
    const result = await provider.getOrder("ORDER/123");
    expect(result.ok).toBe(true);
    const getCall = calls.find((call) => call.url.includes("/v2/checkout/orders/"));
    expect(getCall?.url).toContain("ORDER%2F123");
    expect(getCall?.init?.method).toBe("GET");
  });

  it("captures successfully and exposes provider capture evidence", async () => {
    const captured = order({
      status: "COMPLETED",
      purchase_units: [
        {
          reference_id: "req-001",
          amount: { currency_code: "USD", value: "12.34" },
          payee: { email_address: "merchant@example.com", merchant_id: "MERCHANT-123" },
          payments: {
            captures: [
              {
                id: "CAPTURE-123",
                status: "COMPLETED",
                amount: { currency_code: "USD", value: "12.34" },
              },
            ],
          },
        },
      ],
    });
    const { provider, calls } = sandboxProvider(withToken(async () => response(201, captured)));
    const result = await provider.captureOrder("ORDER-123", 1234n, "req-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const capture = findPayPalCapture(result.data, "req-001");
      expect(capture?.id).toBe("CAPTURE-123");
      expect(provider.isCaptureSuccessful(capture?.status ?? "")).toBe(true);
    }
    const captureCall = calls.find((call) => call.url.endsWith("/capture"));
    expect(captureCall?.init?.method).toBe("POST");
    expect(captureCall?.init?.headers?.["paypal-request-id"]).toBe("req-001");
  });

  it("reports a definite failed capture without ambiguity", async () => {
    const { provider } = sandboxProvider(
      withToken(async () =>
        response(422, {
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "TRANSACTION_REFUSED", description: "refused" }],
        }),
      ),
    );
    const result = await provider.captureOrder("ORDER-123", 1234n, "req-001");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HTTP_ERROR");
      expect(result.error.ambiguous).toBe(false);
      expect(result.error.message).toContain("TRANSACTION_REFUSED");
      expect(result.error.message).not.toContain(CLIENT_SECRET);
    }
  });

  it("marks network failures during capture as ambiguous", async () => {
    let apiCalls = 0;
    const { provider } = sandboxProvider(async (call) => {
      if (call.url.endsWith("/v1/oauth2/token")) {
        return response(200, { access_token: TOKEN, expires_in: 3600 });
      }
      apiCalls += 1;
      throw new Error("connection reset by peer");
    });
    const result = await provider.captureOrder("ORDER-123", 1234n, "req-001");
    expect(apiCalls).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ERROR");
      expect(result.error.ambiguous).toBe(true);
    }
  });

  it("recognizes duplicate capture responses", async () => {
    const { provider } = sandboxProvider(
      withToken(async () =>
        response(422, {
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "ORDER_ALREADY_CAPTURED" }],
        }),
      ),
    );
    const result = await provider.captureOrder("ORDER-123", 1234n, "req-001");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ORDER_ALREADY_CAPTURED");
  });
});

describe("PayPal provider mock mode", () => {
  it("never contacts the network and is explicitly labelled as simulation", async () => {
    let networkCalls = 0;
    const fetchImpl: PayPalFetch = async () => {
      networkCalls += 1;
      return response(500, {});
    };
    const provider = new PayPalProvider(config({ mode: "mock", fetchImpl }));
    const created = await provider.createOrder("req-mock", 500n, "merchant@example.com");
    expect(networkCalls).toBe(0);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.mode).toBe("mock");
    expect(created.data.id.startsWith("MOCK-ORDER-")).toBe(true);
    expect(provider.getApprovalUrl(created.data)).toBeNull();

    const beforeApproval = await provider.captureOrder(created.data.id, 500n, "req-mock");
    expect(beforeApproval.ok).toBe(false);

    expect(provider.approveMockOrder(created.data.id)).toBe(true);
    const captured = await provider.captureOrder(created.data.id, 500n, "req-mock");
    expect(captured.ok).toBe(true);
    if (captured.ok) {
      expect(captured.mode).toBe("mock");
      expect(findPayPalCapture(captured.data, "req-mock")?.status).toBe("COMPLETED");
    }
  });

  it("does not allow mock approval to mutate sandbox orders", () => {
    const provider = new PayPalProvider(config({ fetchImpl: async () => response(200, {}) }));
    expect(provider.approveMockOrder("ORDER-123")).toBe(false);
  });
});
