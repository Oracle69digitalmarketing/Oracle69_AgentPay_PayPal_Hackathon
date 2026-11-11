/**
 * PayPal REST provider — server-side only.
 *
 * Two explicitly separated modes:
 * - "sandbox": talks to the PayPal sandbox REST API using OAuth client
 *   credentials. Every result is real provider data.
 * - "mock": deterministic, network-free simulation used for local/hackathon
 *   testing when sandbox credentials are unavailable. Results are always
 *   tagged `mode: "mock"` and never claim to be a real PayPal transaction.
 *
 * Credentials are held only in this object. They are never logged, returned
 * in results, or included in error messages.
 */

export type PayPalMode = "sandbox" | "mock";

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  merchantId: string;
  /** Defaults to "sandbox". Mock must be selected explicitly by the caller. */
  mode?: PayPalMode;
  timeoutMs?: number;
  fetchImpl?: PayPalFetch;
  now?: () => number;
}

export interface PayPalHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type PayPalFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<PayPalHttpResponse>;

export interface PayPalOrderAmount {
  currency_code?: string;
  value?: string;
}

export interface PayPalPayee {
  email_address?: string;
  merchant_id?: string;
}

export interface PayPalCapture {
  id: string;
  status: string;
  amount?: PayPalOrderAmount;
  final_capture?: boolean;
  create_time?: string;
  update_time?: string;
}

export interface PayPalPurchaseUnit {
  reference_id?: string;
  amount?: PayPalOrderAmount;
  payee?: PayPalPayee;
  status?: string;
  payments?: {
    captures?: PayPalCapture[];
  };
}

export interface PayPalOrderLink {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalOrder {
  id: string;
  status: string;
  purchase_units?: PayPalPurchaseUnit[];
  links?: PayPalOrderLink[];
}

export type PayPalProviderErrorCode =
  | "AUTH_FAILED"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "INVALID_ARGUMENT"
  | "ORDER_ALREADY_CAPTURED";

export interface PayPalProviderError {
  code: PayPalProviderErrorCode;
  message: string;
  ambiguous: boolean;
  httpStatus?: number;
}

export interface PayPalProviderSuccess<T> {
  ok: true;
  mode: PayPalMode;
  data: T;
}

export interface PayPalProviderFailure {
  ok: false;
  mode: PayPalMode;
  error: PayPalProviderError;
}

export type PayPalProviderResult<T> = PayPalProviderSuccess<T> | PayPalProviderFailure;

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Refuses every non-Sandbox API endpoint. The application has no Live-mode
 * path: even a hostile or accidental environment override cannot point the
 * provider at production PayPal.
 */
export function isPayPalSandboxBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "sandbox.paypal.com" || host.endsWith(".sandbox.paypal.com");
}

function safeIssue(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const details = body["details"];
  if (Array.isArray(details)) {
    for (const d of details) {
      if (isRecord(d) && typeof d["issue"] === "string" && /^[A-Z0-9_]+$/.test(d["issue"])) {
        return d["issue"];
      }
    }
  }
  if (typeof body["name"] === "string" && /^[A-Z0-9_]+$/.test(body["name"])) return body["name"];
  return null;
}

function amountMinorToUsdString(amountMinor: bigint): string {
  const whole = amountMinor / 100n;
  const cents = amountMinor % 100n;
  return `${whole.toString()}.${cents.toString().padStart(2, "0")}`;
}

function fail(
  mode: PayPalMode,
  code: PayPalProviderErrorCode,
  message: string,
  ambiguous: boolean,
  httpStatus?: number,
): PayPalProviderFailure {
  const error: PayPalProviderError = { code, message, ambiguous };
  if (httpStatus !== undefined) error.httpStatus = httpStatus;
  return { ok: false, mode, error };
}

/**
 * Extracts the buyer approval URL from PayPal order links. Supports both the
 * classic `approve` relation and newer `payer-action` relation.
 */
export function getOrderApprovalUrl(order: PayPalOrder): string | null {
  const links = Array.isArray(order.links) ? order.links : [];
  for (const rel of ["approve", "payer-action"]) {
    const link = links.find((candidate) => candidate.rel === rel);
    if (link && typeof link.href === "string" && /^https:\/\//.test(link.href)) return link.href;
  }
  return null;
}

/** Finds the captured payment inside a PayPal capture/order response. */
export function findPayPalCapture(order: PayPalOrder, requestId: string): PayPalCapture | null {
  const units = Array.isArray(order.purchase_units) ? order.purchase_units : [];
  const ordered = [
    ...units.filter((u) => u.reference_id === requestId),
    ...units.filter((u) => u.reference_id !== requestId),
  ];
  for (const unit of ordered) {
    const captures = unit.payments?.captures;
    if (Array.isArray(captures) && captures.length > 0) {
      const capture = captures[captures.length - 1];
      if (capture && typeof capture.id === "string") return capture;
    }
  }
  return null;
}

export class PayPalProvider {
  public readonly mode: PayPalMode;
  private readonly fetchImpl: PayPalFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private token: CachedToken | null = null;
  private mockCounter = 0;
  private readonly mockOrders = new Map<string, PayPalOrder>();

  constructor(public readonly config: PayPalConfig) {
    this.mode = config.mode === "mock" ? "mock" : "sandbox";
    if (this.mode === "sandbox") {
      if (!config.clientId || !config.clientSecret || !config.baseUrl || !config.merchantId) {
        throw new Error("PayPal sandbox configuration is incomplete");
      }
      if (!isPayPalSandboxBaseUrl(config.baseUrl)) {
        throw new Error("PayPal baseUrl must be a PayPal Sandbox https endpoint; Live mode is not supported");
      }
    }
    const candidate = config.fetchImpl ?? (globalThis as { fetch?: PayPalFetch }).fetch;
    if (typeof candidate !== "function") throw new Error("fetch is unavailable");
    this.fetchImpl = candidate;
    this.now = config.now ?? (() => Date.now());
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  get isMock(): boolean {
    return this.mode === "mock";
  }

  isCaptureSuccessful(status: string): boolean {
    return status === "CAPTURED" || status === "COMPLETED";
  }

  /**
   * Returns the real PayPal approval URL in sandbox mode. In mock mode this
   * deliberately returns null so the UI cannot present a fake provider URL.
   * When only an order id is supplied, the documented sandbox checkout URL
   * is used as a fallback.
   */
  getApprovalUrl(orderOrId: PayPalOrder | string): string | null {
    if (this.mode === "mock") return null;
    if (typeof orderOrId !== "string") {
      const fromLinks = getOrderApprovalUrl(orderOrId);
      if (fromLinks !== null) return fromLinks;
      return `https://www.sandbox.paypal.com/checkoutnow?token=${encodeURIComponent(orderOrId.id)}`;
    }
    return `https://www.sandbox.paypal.com/checkoutnow?token=${encodeURIComponent(orderOrId)}`;
  }

  /** Marks an order approved in mock mode only. Never available in sandbox. */
  approveMockOrder(orderId: string): boolean {
    if (this.mode !== "mock") return false;
    const order = this.mockOrders.get(orderId);
    if (!order || order.status !== "CREATED") return false;
    order.status = "APPROVED";
    return true;
  }

  async createOrder(
    requestId: string,
    amountMinor: bigint,
    receiver: string,
  ): Promise<PayPalProviderResult<PayPalOrder>> {
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
      return fail(this.mode, "INVALID_ARGUMENT", "requestId is invalid", false);
    }
    if (typeof amountMinor !== "bigint" || amountMinor <= 0n) {
      return fail(this.mode, "INVALID_ARGUMENT", "amount must be a positive bigint in cents", false);
    }
    if (typeof receiver !== "string" || receiver.length === 0) {
      return fail(this.mode, "INVALID_ARGUMENT", "receiver is invalid", false);
    }

    if (this.mode === "mock") return this.mockCreateOrder(requestId, amountMinor, receiver);

    const value = amountMinorToUsdString(amountMinor);
    const payee = receiver.includes("@") ? { email_address: receiver } : { merchant_id: receiver };
    return this.request<PayPalOrder>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: requestId,
            amount: { currency_code: "USD", value },
            payee,
          },
        ],
        application_context: {
          brand_name: "Oracle69 AgentPay",
          user_action: "PAY_NOW",
        },
      },
      requestId,
      false,
    );
  }

  async getOrder(orderId: string): Promise<PayPalProviderResult<PayPalOrder>> {
    if (typeof orderId !== "string" || orderId.length === 0 || orderId.length > 256) {
      return fail(this.mode, "INVALID_ARGUMENT", "orderId is invalid", false);
    }
    if (this.mode === "mock") {
      const order = this.mockOrders.get(orderId);
      if (!order) return fail(this.mode, "INVALID_RESPONSE", "mock order not found", false);
      return { ok: true, mode: this.mode, data: order };
    }
    return this.request<PayPalOrder>(
      "GET",
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      undefined,
      undefined,
      false,
    );
  }

  async captureOrder(
    orderId: string,
    amountMinor: bigint,
    requestId: string,
  ): Promise<PayPalProviderResult<PayPalOrder>> {
    if (typeof orderId !== "string" || orderId.length === 0) {
      return fail(this.mode, "INVALID_ARGUMENT", "orderId is invalid", false);
    }
    if (typeof amountMinor !== "bigint" || amountMinor <= 0n) {
      return fail(this.mode, "INVALID_ARGUMENT", "amount must be a positive bigint in cents", false);
    }
    if (typeof requestId !== "string" || requestId.length === 0) {
      return fail(this.mode, "INVALID_ARGUMENT", "requestId is invalid", false);
    }

    if (this.mode === "mock") return this.mockCaptureOrder(orderId, amountMinor, requestId);

    return this.request<PayPalOrder>(
      "POST",
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {},
      requestId,
      true,
    );
  }

  private mockCreateOrder(
    requestId: string,
    amountMinor: bigint,
    receiver: string,
  ): PayPalProviderResult<PayPalOrder> {
    this.mockCounter += 1;
    const id = `MOCK-ORDER-${requestId}-${this.mockCounter}`;
    const order: PayPalOrder = {
      id,
      status: "CREATED",
      purchase_units: [
        {
          reference_id: requestId,
          amount: { currency_code: "USD", value: amountMinorToUsdString(amountMinor) },
          payee: { email_address: receiver.trim().toLowerCase() },
        },
      ],
      links: [{ rel: "approve", href: `mock://paypal/approve/${encodeURIComponent(id)}`, method: "GET" }],
    };
    this.mockOrders.set(id, order);
    return { ok: true, mode: this.mode, data: order };
  }

  private mockCaptureOrder(
    orderId: string,
    amountMinor: bigint,
    requestId: string,
  ): PayPalProviderResult<PayPalOrder> {
    const order = this.mockOrders.get(orderId);
    if (!order) return fail(this.mode, "INVALID_RESPONSE", "mock order not found", false);
    const existing = findPayPalCapture(order, requestId);
    if (existing) {
      return fail(this.mode, "ORDER_ALREADY_CAPTURED", "mock order was already captured", false);
    }
    if (order.status !== "APPROVED") {
      return fail(this.mode, "HTTP_ERROR", "mock order is not approved", false, 422);
    }
    const value = amountMinorToUsdString(amountMinor);
    order.status = "COMPLETED";
    order.purchase_units = (order.purchase_units ?? []).map((unit) => ({
      ...unit,
      status: "COMPLETED",
      payments: {
        captures: [
          {
            id: `MOCK-CAPTURE-${requestId}`,
            status: "COMPLETED",
            amount: { currency_code: "USD", value },
            final_capture: true,
            create_time: new Date(this.now()).toISOString(),
            update_time: new Date(this.now()).toISOString(),
          },
        ],
      },
    }));
    return { ok: true, mode: this.mode, data: order };
  }

  private async getAccessToken(): Promise<{ ok: true; token: string } | { ok: false; result: PayPalProviderFailure }> {
    const now = this.now();
    if (this.token !== null && now < this.token.expiresAtMs) {
      return { ok: true, token: this.token.value };
    }
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, "utf8").toString("base64");
    let response: PayPalHttpResponse;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${credentials}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return {
        ok: false,
        result: fail(
          this.mode,
          isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
          isTimeout ? "PayPal authentication timed out" : "PayPal authentication network failure",
          false,
        ),
      };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok || !isRecord(body) || typeof body["access_token"] !== "string") {
      return {
        ok: false,
        result: fail(
          this.mode,
          "AUTH_FAILED",
          `PayPal authentication failed (HTTP ${response.status})`,
          false,
          response.status,
        ),
      };
    }
    const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 300;
    const safetyWindowMs = 60_000;
    this.token = {
      value: body["access_token"],
      expiresAtMs: now + Math.max(30, expiresIn) * 1000 - safetyWindowMs,
    };
    return { ok: true, token: this.token.value };
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    idempotencyKey: string | undefined,
    captureSemantics: boolean,
  ): Promise<PayPalProviderResult<T>> {
    const tokenResult = await this.getAccessToken();
    if (!tokenResult.ok) return tokenResult.result;

    const headers: Record<string, string> = {
      authorization: `Bearer ${tokenResult.token}`,
      "content-type": "application/json",
    };
    if (idempotencyKey !== undefined) headers["paypal-request-id"] = idempotencyKey;
    if (method === "POST") headers["prefer"] = "return=representation";

    let response: PayPalHttpResponse;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return fail(
        this.mode,
        isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
        isTimeout ? "PayPal request timed out" : "PayPal network failure",
        captureSemantics,
      );
    }

    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const issue = safeIssue(parsed);
      if (issue === "ORDER_ALREADY_CAPTURED") {
        return fail(this.mode, "ORDER_ALREADY_CAPTURED", "PayPal order was already captured", false, response.status);
      }
      const ambiguous = captureSemantics && (response.status >= 500 || response.status === 408 || response.status === 429);
      return fail(
        this.mode,
        "HTTP_ERROR",
        `PayPal request failed (HTTP ${response.status})${issue !== null ? `: ${issue}` : ""}`,
        ambiguous,
        response.status,
      );
    }

    if (!isRecord(parsed) || typeof parsed["id"] !== "string" || typeof parsed["status"] !== "string") {
      return fail(this.mode, "INVALID_RESPONSE", "PayPal returned an unexpected response", captureSemantics);
    }
    return { ok: true, mode: this.mode, data: parsed as unknown as T };
  }
}
