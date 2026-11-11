/**
 * PayPal HTTP API — server-side only.
 *
 * All six PayPal lifecycle routes are mounted here:
 *   POST /api/paypal/intent
 *   POST /api/paypal/order
 *   GET  /api/paypal/order/:id
 *   POST /api/paypal/approve
 *   POST /api/paypal/capture
 *   GET  /api/paypal/payment/:id
 *   GET  /api/paypal/payment/:id/audit
 *
 * A helper POST /api/paypal/extract turns a natural-language instruction
 * into reviewed payment details and a policy decision without reserving a
 * payment or contacting PayPal.
 *
 * SECURITY INVARIANTS:
 * - PayPal credentials exist only inside the provider instance. They never
 *   appear in responses or logs, and provider errors are sanitized.
 * - Clients cannot set lifecycle state directly: unknown body fields are
 *   rejected, approval is confirmed against provider order data, and capture
 *   is performed by the server against the bound provider order.
 * - Mock mode is explicit in every response (`providerMode`/`simulated`) and
 *   never exposes a real-looking PayPal approval URL.
 * - Policy is evaluated at reservation AND re-evaluated before capture.
 * - UNKNOWN capture outcomes are terminal for automatic retry.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { evaluatePayPalPolicy } from "../src/paypal/engine.js";
import { computePayPalPaymentDigest, computePayPalPolicyDigest } from "../src/paypal/digest.js";
import { explainPaymentRecord, explainPolicyDecision } from "../src/paypal/explanation.js";
import { extractPaymentInstruction } from "../src/paypal/instruction.js";
import { aiInterpret } from "../src/paypal/instruction.js";
import {
  PayPalProvider,
  findPayPalCapture,
  type PayPalCapture,
  type PayPalOrder,
  type PayPalProviderResult,
  type PayPalPurchaseUnit,
} from "../src/paypal/provider.js";
import { createPayPalStore, type PayPalStore } from "../src/paypal/store/sqlite-store.js";
import type {
  PayPalIntent,
  PayPalLifecycleState,
  PayPalPaymentRecord,
  PayPalPolicyConfig,
  PayPalReason,
} from "../src/paypal/types.js";
import { normalizePayPalReceiver, parseDecimalUsdToMinor } from "../src/paypal/validation.js";

const MAX_BODY_BYTES = 16 * 1024;
const INTENT_TTL_SECONDS = 3600;
const DEFAULT_RECEIVER = "merchant@example.com";
const OPERATOR_ID = "server-web-operator";

export interface PayPalRuntimeConfig {
  policy: PayPalPolicyConfig;
  operatorToken?: string | undefined;
  authMode?: "operator-token" | "local-unauthenticated" | undefined;
}

export interface PayPalRouterOptions {
  provider?: PayPalProvider;
  store?: PayPalStore;
  runtime?: PayPalRuntimeConfig;
  now?: () => number;
  randomId?: (prefix: string) => string;
}

export interface PayPalRequestHandler {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): void;
}

type JsonObject = Record<string, unknown>;

interface ParsedBody {
  ok: true;
  value: JsonObject;
}
interface BodyFailure {
  ok: false;
  status: number;
  error: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  } catch {
    // Dead socket: no response is possible or necessary.
  }
}

function isRecord(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) reject(new Error("body too large"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err: unknown) => reject(err instanceof Error ? err : new Error("body read failed")));
  });
}

async function readJsonBody(req: IncomingMessage): Promise<ParsedBody | BodyFailure> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return { ok: false, status: 413, error: "request body too large or unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
  if (!isRecord(parsed)) return { ok: false, status: 400, error: "request body must be a JSON object" };
  return { ok: true, value: parsed };
}

function rejectUnknownFields(body: JsonObject, allowed: readonly string[]): string | null {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) return `unexpected field ${key}`;
  }
  return null;
}

function isSafeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000\r\n]/.test(value);
}

export interface OperatorAuthEnvironment {
  nodeEnv?: string | undefined;
  publicDeployment?: string | undefined;
  requireAuth?: string | undefined;
}

export interface ResolvedOperatorAuth {
  operatorToken?: string | undefined;
  required: boolean;
  mode: "operator-token" | "local-unauthenticated";
}

/**
 * Resolves operator authentication from environment flags.
 *
 * Local development/mock demos may run without a token, but public or
 * production deployments fail at startup rather than silently accepting
 * unauthenticated state changes.
 */
export function resolveOperatorAuth(
  token: string | undefined,
  env: OperatorAuthEnvironment,
): ResolvedOperatorAuth {
  const configured = typeof token === "string" && token.length > 0 ? token : undefined;
  const required =
    env.nodeEnv === "production" ||
    env.publicDeployment === "true" ||
    env.requireAuth === "true";
  if (required && configured === undefined) {
    throw new Error(
      "PAYPAL_OPERATOR_TOKEN is required when NODE_ENV=production or PAYPAL_PUBLIC_DEPLOYMENT/PAYPAL_REQUIRE_OPERATOR_AUTH is true",
    );
  }
  return {
    operatorToken: configured,
    required: configured !== undefined || required,
    mode: configured !== undefined ? "operator-token" : "local-unauthenticated",
  };
}

function defaultOperatorAuth(): ResolvedOperatorAuth {
  const token = process.env["PAYPAL_OPERATOR_TOKEN"];
  return resolveOperatorAuth(token, {
    nodeEnv: process.env["NODE_ENV"],
    publicDeployment: process.env["PAYPAL_PUBLIC_DEPLOYMENT"],
    requireAuth: process.env["PAYPAL_REQUIRE_OPERATOR_AUTH"],
  });
}

function isAuthorized(req: IncomingMessage, operatorToken: string | undefined): boolean {
  if (operatorToken === undefined) return true;
  const header = req.headers["x-agentpay-operator-token"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(operatorToken, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function createPayPalPolicyFromEnv(): PayPalPolicyConfig {
  const receivers = splitList(process.env["PAYPAL_ALLOWED_RECEIVERS"]);
  const configuredMax = process.env["PAYPAL_MAX_MINOR"];
  let maxPerPaymentMinor = 1000n;
  if (configuredMax !== undefined && /^[0-9]+$/.test(configuredMax)) {
    maxPerPaymentMinor = BigInt(configuredMax);
  }
  return {
    allowedReceivers: receivers.length > 0 ? receivers : [DEFAULT_RECEIVER],
    maxPerPaymentMinor,
    currency: "USD",
    requireHumanApproval: true,
  };
}

export function createPayPalProviderFromEnv(): PayPalProvider {
  const configuredMode = (process.env["PAYPAL_MODE"] ?? "").trim().toLowerCase();
  const clientId = process.env["PAYPAL_CLIENT_ID"] ?? "";
  const clientSecret = process.env["PAYPAL_CLIENT_SECRET"] ?? "";
  const merchantId = process.env["PAYPAL_MERCHANT_ID"] ?? "";
  const baseUrl = process.env["PAYPAL_BASE_URL"] ?? "https://api.sandbox.paypal.com";
  const hasCredentials = clientId.length > 0 && clientSecret.length > 0;

  let mode: "sandbox" | "mock";
  if (configuredMode === "mock") {
    mode = "mock";
  } else if (configuredMode === "sandbox") {
    mode = "sandbox";
  } else if (configuredMode === "") {
    mode = hasCredentials ? "sandbox" : "mock";
  } else {
    throw new Error("PAYPAL_MODE must be either sandbox or mock");
  }

  if (mode === "sandbox" && (!hasCredentials || merchantId.length === 0)) {
    throw new Error(
      "PayPal sandbox mode requires PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_MERCHANT_ID",
    );
  }

  return new PayPalProvider({
    clientId,
    clientSecret,
    baseUrl,
    merchantId: mode === "mock" && merchantId.length === 0 ? "MOCK_MERCHANT" : merchantId,
    mode,
  });
}

function createDefaultStore(): PayPalStore {
  const configured = process.env["PAYPAL_DB_PATH"];
  const path = configured !== undefined && configured.length > 0 ? configured : join("data", "paypal.sqlite");
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  return createPayPalStore(path);
}

function defaultRandomId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, "")}`;
}

function amountMinorToNumber(amountMinor: bigint): number {
  if (amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount is too large");
  return Number(amountMinor);
}

function providerFailureBody(result: Extract<PayPalProviderResult<unknown>, { ok: false }>, state: PayPalLifecycleState) {
  return {
    ok: false,
    state,
    code: result.error.code,
    error: result.error.message,
    ambiguous: result.error.ambiguous,
    providerMode: result.mode,
    simulated: result.mode === "mock",
  };
}

function policyReasonsWithoutApproval(decision: ReturnType<typeof evaluatePayPalPolicy>): PayPalReason[] {
  if (decision.allowed) return [];
  return decision.reasons.filter((reason) => reason.code !== "MISSING_APPROVAL");
}

function intentFromRecord(record: PayPalPaymentRecord): PayPalIntent {
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

function findBoundUnit(order: PayPalOrder, requestId: string): PayPalPurchaseUnit | null {
  const units = Array.isArray(order.purchase_units) ? order.purchase_units : [];
  const exact = units.find((unit) => unit.reference_id === requestId);
  if (exact) return exact;
  return null;
}

interface BindingCheck {
  ok: boolean;
  code?: string;
  message?: string;
}

function verifyUnitBinding(
  unit: PayPalPurchaseUnit | null,
  record: PayPalPaymentRecord,
  expectedMerchantId: string,
): BindingCheck {
  if (unit === null) {
    return { ok: false, code: "ORDER_MISMATCH", message: "provider order is not bound to the reserved reference_id" };
  }
  if (unit.amount === undefined || typeof unit.amount.value !== "string" || typeof unit.amount.currency_code !== "string") {
    return { ok: false, code: "AMOUNT_MISMATCH", message: "provider order has no verifiable amount" };
  }
  if (unit.amount.currency_code !== record.currency) {
    return { ok: false, code: "CURRENCY_MISMATCH", message: "provider currency does not match the reserved payment" };
  }
  let observedMinor: bigint;
  try {
    observedMinor = parseDecimalUsdToMinor(unit.amount.value);
  } catch {
    return { ok: false, code: "AMOUNT_MISMATCH", message: "provider amount is malformed" };
  }
  if (observedMinor !== record.amountMinor) {
    return { ok: false, code: "AMOUNT_MISMATCH", message: "provider amount does not match the reserved payment" };
  }

  const payee = unit.payee;
  const email = typeof payee?.email_address === "string" ? normalizePayPalReceiver(payee.email_address) : null;
  const merchant = typeof payee?.merchant_id === "string" ? payee.merchant_id : null;
  const isEmailReceiver = record.receiver.includes("@");

  if (isEmailReceiver) {
    // --- Email receiver: payee email must match reserved receiver ---
    // --- If provider merchant_id is present, it MUST match configured merchant ---
    const emailMatches = email !== null && email === record.receiver;
    const merchantProvided = merchant !== null && merchant.length > 0;
    const merchantMatchesExpected = !merchantProvided || expectedMerchantId.length === 0 || merchant === expectedMerchantId;

    if (!emailMatches) {
      return { ok: false, code: "MERCHANT_MISMATCH", message: "provider payee email does not match the reserved payment" };
    }
    if (merchantProvided && !merchantMatchesExpected) {
      return { ok: false, code: "MERCHANT_MISMATCH", message: "provider merchant_id does not match the configured merchant" };
    }
    return { ok: true };
  }

  // --- Merchant-ID / payer-id receiver: provider merchant_id must match reserved receiver ---
  // --- Provider merchant_id must also match configured merchant ---
  // --- Provider email must never compensate for a merchant-ID mismatch ---
  const merchantMatchesReceiver = merchant !== null && normalizePayPalReceiver(merchant) === record.receiver;
  const merchantMatchesConfig = expectedMerchantId.length > 0 && merchant !== null && merchant === expectedMerchantId;

  if (!merchantMatchesReceiver) {
    return { ok: false, code: "MERCHANT_MISMATCH", message: "provider merchant ID does not match the reserved payment" };
  }
  if (!merchantMatchesConfig) {
    return { ok: false, code: "MERCHANT_MISMATCH", message: "provider merchant ID does not match the configured merchant" };
  }
  return { ok: true };
}

interface VerifiedCapture {
  ok: boolean;
  capture?: PayPalCapture;
  code?: string;
  message?: string;
  ambiguous?: boolean;
}

function verifyCaptureResponse(
  order: PayPalOrder,
  capture: PayPalCapture | null,
  record: PayPalPaymentRecord,
  expectedMerchantId: string,
): VerifiedCapture {
  if (capture === null) {
    return {
      ok: false,
      code: "INVALID_RESPONSE",
      message: "provider did not return capture evidence",
      ambiguous: true,
    };
  }
  if (capture.status !== "COMPLETED" && capture.status !== "CAPTURED") {
    const ambiguous = capture.status === "PENDING";
    return {
      ok: false,
      code: ambiguous ? "CAPTURE_PENDING" : "CAPTURE_FAILED",
      message: ambiguous ? "PayPal capture is pending" : "PayPal capture did not complete",
      ambiguous,
    };
  }
  if (typeof capture.id !== "string" || capture.id.length === 0) {
    return { ok: false, code: "INVALID_RESPONSE", message: "provider capture id is missing", ambiguous: true };
  }
  if (capture.amount === undefined || typeof capture.amount.value !== "string" || typeof capture.amount.currency_code !== "string") {
    return { ok: false, code: "AMOUNT_MISMATCH", message: "capture has no verifiable amount", ambiguous: true };
  }
  if (capture.amount.currency_code !== record.currency) {
    return { ok: false, code: "CURRENCY_MISMATCH", message: "capture currency does not match the reserved payment", ambiguous: true };
  }
  let capturedMinor: bigint;
  try {
    capturedMinor = parseDecimalUsdToMinor(capture.amount.value);
  } catch {
    return { ok: false, code: "AMOUNT_MISMATCH", message: "capture amount is malformed", ambiguous: true };
  }
  if (capturedMinor !== record.amountMinor) {
    return { ok: false, code: "AMOUNT_MISMATCH", message: "capture amount does not match the reserved payment", ambiguous: true };
  }
  const binding = verifyUnitBinding(findBoundUnit(order, record.requestId), record, expectedMerchantId);
  if (!binding.ok) return { ...binding, ambiguous: true };
  return { ok: true, capture };
}

function publicStatus(
  record: PayPalPaymentRecord,
  provider: PayPalProvider,
  policy: PayPalPolicyConfig,
  now: number,
) {
  const captureVerified =
    record.state === "CAPTURED" && typeof record.captureId === "string" && record.captureId.length > 0;
  return {
    ok: true,
    requestId: record.requestId,
    paymentId: record.requestId,
    state: record.state,
    receiver: record.receiver,
    amountMinor: amountMinorToNumber(record.amountMinor),
    amountUsd: (Number(record.amountMinor) / 100).toFixed(2),
    currency: record.currency,
    purpose: record.purpose,
    captureId: record.captureId,
    paypalCaptureId: record.captureId,
    transactionReference: captureVerified ? record.captureId : null,
    orderId: record.providerOrderId,
    paypalOrderId: record.providerOrderId,
    verified: captureVerified,
    captureVerified,
    createdAt: record.createdAt,
    captureVerifiedAt: captureVerified ? record.lastTransitionedAt : null,
    approvalVerifiedAt: record.approvalBinding === null ? null : record.approvalBinding.verifiedAt,
    providerMode: provider.mode,
    simulated: provider.isMock,
    explanation: explainPaymentRecord(record, policy, {
      now,
      providerMode: provider.mode,
      simulated: provider.isMock,
    }),
    approvalBinding:
      record.approvalBinding === null
        ? null
        : {
            paymentDigest: record.approvalBinding.paymentDigest,
            policyDigest: record.approvalBinding.policyDigest,
            requestId: record.approvalBinding.requestId,
            operatorId: record.approvalBinding.operatorId,
            verifiedAt: record.approvalBinding.verifiedAt,
          },
  };
}

export function createPayPalRouter(options: PayPalRouterOptions = {}): PayPalRequestHandler {
  const provider = options.provider ?? createPayPalProviderFromEnv();
  const store = options.store ?? createDefaultStore();
  const envAuth = options.runtime === undefined ? defaultOperatorAuth() : null;
  const runtime: PayPalRuntimeConfig =
    options.runtime ?? {
      policy: createPayPalPolicyFromEnv(),
      operatorToken: envAuth?.operatorToken,
      authMode: envAuth?.mode,
    };
  const authMode =
    runtime.authMode ?? (runtime.operatorToken !== undefined ? "operator-token" : "local-unauthenticated");
  const nowFn = options.now ?? (() => Math.floor(Date.now() / 1000));
  const randomIdFn = options.randomId ?? defaultRandomId;
  const policyDigest = computePayPalPolicyDigest(runtime.policy);
  const explainRecord = (record: PayPalPaymentRecord, at: number = nowFn()) =>
    explainPaymentRecord(record, runtime.policy, {
      now: at,
      providerMode: provider.mode,
      simulated: provider.isMock,
    });

  async function handleExtract(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const unknown = rejectUnknownFields(body.value, ["instruction"]);
    if (unknown !== null) return sendJson(res, 400, { error: unknown });
    const extraction = extractPaymentInstruction(body.value["instruction"]);
    if (!extraction.ok) return sendJson(res, 400, { error: "could not extract payment details", reasons: extraction.reasons });

    const now = nowFn();
    const intent: PayPalIntent = {
      requestId: randomIdFn("req"),
      receiver: extraction.value.receiver,
      amountMinor: extraction.value.amountMinor,
      currency: "USD",
      purpose: extraction.value.purpose,
      nonce: randomIdFn("nonce"),
      expiresAt: now + INTENT_TTL_SECONDS,
    };
    const decision = evaluatePayPalPolicy(intent, runtime.policy, { now, humanApprovalVerified: false });
    const blockingReasons = policyReasonsWithoutApproval(decision);
    return sendJson(res, 200, {
      ok: true,
      extracted: {
        receiver: intent.receiver,
        amountMinor: amountMinorToNumber(intent.amountMinor),
        amountUsd: (Number(intent.amountMinor) / 100).toFixed(2),
        currency: intent.currency,
        purpose: intent.purpose,
      },
      intent: {
        ...intent,
        amountMinor: amountMinorToNumber(intent.amountMinor),
      },
      policy: {
        allowed: blockingReasons.length === 0,
        requiresHumanApproval: runtime.policy.requireHumanApproval,
        reasons: blockingReasons,
        preApprovalReasons: decision.allowed ? [] : decision.reasons,
      },
      explanation: explainPolicyDecision(intent, runtime.policy, decision, {
        now,
        providerMode: provider.mode,
        simulated: provider.isMock,
      }),
      providerMode: provider.mode,
      simulated: provider.isMock,
    });
  }


  async function handleAiExtract(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAuthorized(req, runtime.operatorToken)) return sendJson(res, 401, { error: "unauthorized" });
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    if (typeof body.value?.instruction !== "string" || body.value.instruction.trim().length === 0) {
      return sendJson(res, 400, { error: "instruction is required and must be a non-empty string" });
    }

    try {
      const result = await aiInterpret(body.value.instruction);
      if (!result.ok) {
        return sendJson(res, 200, { ok: false, reason: result.reason });
      }
      const { details } = result;
      return sendJson(res, 200, {
        ok: true,
        aiInterpreted: true,
        receiver: details.receiver,
        amount: details.amount,
        currency: details.currency,
        purpose: details.purpose,
      });
    } catch {
      return sendJson(res, 500, { ok: false, reason: "NETWORK_ERROR" });
    }
  }

  async function handleCreateIntent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAuthorized(req, runtime.operatorToken)) return sendJson(res, 401, { error: "unauthorized" });
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const unknown = rejectUnknownFields(body.value, [
      "requestId",
      "receiver",
      "amountMinor",
      "currency",
      "purpose",
      "nonce",
      "expiresAt",
      "instruction",
    ]);
    if (unknown !== null) return sendJson(res, 400, { error: unknown });

    const now = nowFn();
    let receiver = body.value["receiver"];
    let amountMinorRaw = body.value["amountMinor"];
    let purpose = body.value["purpose"];
    if (typeof body.value["instruction"] === "string") {
      const extraction = extractPaymentInstruction(body.value["instruction"]);
      if (!extraction.ok) return sendJson(res, 400, { error: "could not extract payment details", reasons: extraction.reasons });
      receiver = extraction.value.receiver;
      amountMinorRaw = amountMinorToNumber(extraction.value.amountMinor);
      purpose = extraction.value.purpose;
    }
    if (typeof receiver !== "string" || receiver.length === 0) {
      return sendJson(res, 400, { error: "receiver is required" });
    }
    if (typeof amountMinorRaw !== "number" || !Number.isSafeInteger(amountMinorRaw) || amountMinorRaw <= 0) {
      return sendJson(res, 400, { error: "amountMinor must be a positive integer in USD cents" });
    }
    if (body.value["currency"] !== undefined && body.value["currency"] !== "USD") {
      return sendJson(res, 400, { error: "only USD is supported" });
    }
    if (typeof purpose !== "string" || purpose.trim().length === 0) {
      return sendJson(res, 400, { error: "purpose is required" });
    }
    const requestIdRaw = body.value["requestId"];
    const nonceRaw = body.value["nonce"];
    const expiresAtRaw = body.value["expiresAt"];
    if (requestIdRaw !== undefined && typeof requestIdRaw !== "string") {
      return sendJson(res, 400, { error: "requestId must be a string" });
    }
    if (nonceRaw !== undefined && typeof nonceRaw !== "string") {
      return sendJson(res, 400, { error: "nonce must be a string" });
    }
    if (expiresAtRaw !== undefined && (typeof expiresAtRaw !== "number" || !Number.isInteger(expiresAtRaw))) {
      return sendJson(res, 400, { error: "expiresAt must be an integer unix timestamp" });
    }

    const intent: PayPalIntent = {
      requestId: typeof requestIdRaw === "string" && requestIdRaw.length > 0 ? requestIdRaw : randomIdFn("req"),
      receiver,
      amountMinor: BigInt(amountMinorRaw),
      currency: "USD",
      purpose: purpose.trim(),
      nonce: typeof nonceRaw === "string" && nonceRaw.length > 0 ? nonceRaw : randomIdFn("nonce"),
      expiresAt: typeof expiresAtRaw === "number" ? expiresAtRaw : now + INTENT_TTL_SECONDS,
    };

    const decision = evaluatePayPalPolicy(intent, runtime.policy, { now, humanApprovalVerified: false });
    const blockingReasons = policyReasonsWithoutApproval(decision);
    if (blockingReasons.length > 0) {
      return sendJson(res, 400, {
        ok: false,
        error: "policy rejected the payment intent",
        policy: { allowed: false, reasons: blockingReasons, preApprovalReasons: decision.allowed ? [] : decision.reasons },
        explanation: explainPolicyDecision(intent, runtime.policy, decision, {
          now,
          providerMode: provider.mode,
          simulated: provider.isMock,
        }),
        providerMode: provider.mode,
        simulated: provider.isMock,
      });
    }

    const paymentDigest = computePayPalPaymentDigest(intent);
    let claim;
    try {
      claim = store.claim({
        requestId: intent.requestId,
        nonce: intent.nonce,
        receiver: intent.receiver,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        purpose: intent.purpose,
        expiresAt: intent.expiresAt,
        policyDigest,
        paymentDigest,
      });
    } catch {
      return sendJson(res, 500, { error: "could not reserve payment" });
    }
    if (!claim.ok) {
      return sendJson(res, 409, { error: "payment identifiers were already used", reused: claim.reused });
    }

    const orderResult = await provider.createOrder(intent.requestId, intent.amountMinor, intent.receiver);
    if (!orderResult.ok) {
      try {
        store.recordAudit(intent.requestId, {
          eventType: "ORDER_CREATION_FAILED",
          state: "RESERVED",
          message: `PayPal order creation failed with ${orderResult.error.code}. No confirmed charge was recorded.`,
          code: orderResult.error.code,
          operatorId: OPERATOR_ID,
        });
        store.recordFailure(intent.requestId, `PayPal order creation failed with ${orderResult.error.code}.`, OPERATOR_ID);
      } catch {
        // Preserve the safe failure response even if persistence is degraded.
      }
      const failedRecord = store.getRecord(intent.requestId) ?? claim.record;
      return sendJson(res, 502, {
        ...providerFailureBody(orderResult, failedRecord.state),
        requestId: intent.requestId,
        nextStep: "Payment could not be created. No confirmed charge was recorded. Start a new payment request.",
        explanation: explainPaymentRecord(failedRecord, runtime.policy, {
          now: nowFn(),
          providerMode: provider.mode,
          simulated: provider.isMock,
        }),
      });
    }

    let record: PayPalPaymentRecord;
    try {
      record = store.attachProviderOrder(intent.requestId, orderResult.data.id, OPERATOR_ID);
    } catch {
      try {
        store.recordAudit(intent.requestId, {
          eventType: "ORDER_CREATION_FAILED",
          state: "RESERVED",
          message: "PayPal order was created but could not be bound. Capture is disabled.",
          code: "ORDER_BINDING_FAILED",
          operatorId: OPERATOR_ID,
        });
        store.recordFailure(intent.requestId, "PayPal order was created but could not be bound.", OPERATOR_ID);
      } catch {
        // Fail closed with the safe response below.
      }
      const failedRecord = store.getRecord(intent.requestId) ?? claim.record;
      return sendJson(res, 500, {
        ok: false,
        state: failedRecord.state,
        error: "provider order was created but could not be bound; capture is disabled",
        nextStep: "Do not retry this payment. Start a new payment request and contact support if the PayPal order exists.",
        explanation: explainPaymentRecord(failedRecord, runtime.policy, {
          now: nowFn(),
          providerMode: provider.mode,
          simulated: provider.isMock,
        }),
        providerMode: provider.mode,
        simulated: provider.isMock,
      });
    }

    const createdStatus = publicStatus(record, provider, runtime.policy, nowFn());
    return sendJson(res, 200, {
      ...createdStatus,
      expiresAt: record.expiresAt,
      paypalOrderId: record.providerOrderId,
      paypalApprovalUrl: provider.getApprovalUrl(orderResult.data),
      policy: {
        allowed: true,
        requiresHumanApproval: runtime.policy.requireHumanApproval,
        reasons: [],
      },
    });
  }

  async function handleGetOrder(req: IncomingMessage, res: ServerResponse, orderIdFromPath?: string): Promise<void> {
    let orderId = orderIdFromPath;
    if (orderId === undefined) {
      const body = await readJsonBody(req);
      if (!body.ok) return sendJson(res, body.status, { error: body.error });
      const unknown = rejectUnknownFields(body.value, ["orderId"]);
      if (unknown !== null) return sendJson(res, 400, { error: unknown });
      const raw = body.value["orderId"];
      if (typeof raw !== "string" || raw.length === 0) return sendJson(res, 400, { error: "orderId is required" });
      orderId = raw;
    }
    if (typeof orderId !== "string" || orderId.length === 0) return sendJson(res, 400, { error: "order ID is required" });

    const record = store.getRecordByProviderOrderId(orderId);
    if (record === null) {
      return sendJson(res, 404, { error: "order is not bound to a reserved payment" });
    }
    const result = await provider.getOrder(orderId);
    if (!result.ok) return sendJson(res, 502, providerFailureBody(result, record.state));
    if (result.data.id !== orderId) return sendJson(res, 502, { error: "provider returned a different order id", providerMode: provider.mode });
    return sendJson(res, 200, {
      ok: true,
      requestId: record.requestId,
      paymentId: record.requestId,
      order: result.data,
      explanation: explainPaymentRecord(record, runtime.policy, {
        now: nowFn(),
        providerMode: provider.mode,
        simulated: provider.isMock,
      }),
      providerMode: provider.mode,
      simulated: provider.isMock,
    });
  }

  async function handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAuthorized(req, runtime.operatorToken)) return sendJson(res, 401, { error: "unauthorized" });
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const unknown = rejectUnknownFields(body.value, ["requestId", "paypalOrderId"]);
    if (unknown !== null) return sendJson(res, 400, { error: unknown });
    const requestId = body.value["requestId"];
    const paypalOrderId = body.value["paypalOrderId"];
    if (typeof requestId !== "string" || requestId.length === 0) return sendJson(res, 400, { error: "requestId is required" });
    if (typeof paypalOrderId !== "string" || paypalOrderId.length === 0) {
      return sendJson(res, 400, { error: "paypalOrderId is required" });
    }

    const now = nowFn();
    const record = store.getRecord(requestId);
    if (record === null) return sendJson(res, 404, { error: "payment not found" });
    if (record.providerOrderId === null || record.providerOrderId !== paypalOrderId) {
      return sendJson(res, 400, { error: "PayPal order does not match the reserved payment" });
    }
    if ((record.state === "ORDER_CREATED" || record.state === "APPROVED") && now >= record.expiresAt) {
      try {
        store.recordAudit(requestId, {
          eventType: "BUYER_APPROVAL_FAILED",
          state: record.state,
          message: "Payment approval window expired before verification.",
          code: "PAYMENT_EXPIRED",
          operatorId: OPERATOR_ID,
          providerOrderId: paypalOrderId,
        });
        store.transitionState(requestId, "VOIDED", OPERATOR_ID);
      } catch {
        // The expired response below remains fail closed.
      }
      const expired = store.getRecord(requestId) ?? record;
      return sendJson(res, 410, {
        ok: false,
        state: expired.state,
        code: "PAYMENT_EXPIRED",
        error: "Payment approval expired. Start a new payment request.",
        retryable: false,
        explanation: explainPaymentRecord(expired, runtime.policy, {
          now,
          providerMode: provider.mode,
          simulated: provider.isMock,
        }),
        providerMode: provider.mode,
        simulated: provider.isMock,
      });
    }
    if (record.state === "APPROVED") {
      return sendJson(res, 200, {
        ...publicStatus(record, provider, runtime.policy, now),
        alreadyApproved: true,
        paypalOrderId,
      });
    }
    if (record.state !== "ORDER_CREATED") {
      return sendJson(res, 409, { error: "payment is not awaiting approval", state: record.state });
    }

    if (provider.isMock) provider.approveMockOrder(paypalOrderId);
    const orderResult = await provider.getOrder(paypalOrderId);
    if (!orderResult.ok) return sendJson(res, 502, providerFailureBody(orderResult, record.state));
    const order = orderResult.data;
    if (order.id !== record.providerOrderId) {
      return sendJson(res, 409, { error: "provider returned a different order id", code: "ORDER_MISMATCH" });
    }
    if (order.status === "VOIDED") {
      try {
        store.recordAudit(requestId, {
          eventType: "BUYER_APPROVAL_FAILED",
          state: record.state,
          message: "PayPal buyer cancelled or voided the order.",
          code: "BUYER_CANCELLED",
          operatorId: OPERATOR_ID,
          providerOrderId: paypalOrderId,
        });
        store.transitionState(requestId, "VOIDED", OPERATOR_ID);
      } catch {
        // Response below remains fail closed.
      }
      const cancelled = store.getRecord(requestId) ?? record;
      return sendJson(res, 409, {
        ok: false,
        state: cancelled.state,
        code: "BUYER_CANCELLED",
        error: "PayPal buyer cancelled the payment. Start a new payment request.",
        retryable: false,
        explanation: explainPaymentRecord(cancelled, runtime.policy, {
          now: nowFn(),
          providerMode: provider.mode,
          simulated: provider.isMock,
        }),
        providerMode: provider.mode,
        simulated: provider.isMock,
      });
    }
    if (order.status !== "APPROVED") {
      try {
        store.recordAudit(requestId, {
          eventType: "BUYER_APPROVAL_FAILED",
          state: record.state,
          message: `PayPal order is not approved yet (provider status ${order.status}).`,
          code: "ORDER_NOT_APPROVED",
          operatorId: OPERATOR_ID,
          providerOrderId: paypalOrderId,
        });
      } catch {
        // The caller still receives the safe failure response.
      }
      return sendJson(res, 409, {
        error: "PayPal order is not approved yet",
        code: "ORDER_NOT_APPROVED",
        providerStatus: order.status,
        explanation: explainPaymentRecord(record, runtime.policy, {
          now: nowFn(),
          providerMode: provider.mode,
          simulated: provider.isMock,
        }),
        providerMode: provider.mode,
        simulated: provider.isMock,
      });
    }
    const bindingCheck = verifyUnitBinding(
      findBoundUnit(order, record.requestId),
      record,
      provider.config.merchantId,
    );
    if (!bindingCheck.ok) {
      return sendJson(res, 409, {
        error: bindingCheck.message ?? "provider order does not match the reserved payment",
        code: bindingCheck.code ?? "ORDER_MISMATCH",
      });
    }
    if (record.paymentDigest !== computePayPalPaymentDigest(intentFromRecord(record))) {
      return sendJson(res, 409, { error: "stored payment digest no longer matches", code: "PAYMENT_DIGEST_MISMATCH" });
    }
    if (record.policyDigest !== policyDigest) {
      return sendJson(res, 409, { error: "policy changed after reservation; start a new payment", code: "POLICY_CHANGED" });
    }

    try {
      store.recordAudit(requestId, {
        eventType: "BUYER_APPROVAL_VERIFIED",
        state: record.state,
        message: "PayPal buyer approval verified from provider order status.",
        code: "BUYER_APPROVED",
        operatorId: OPERATOR_ID,
        providerOrderId: paypalOrderId,
      });
      store.transitionState(requestId, "APPROVED", OPERATOR_ID);
      store.bindApproval(requestId, {
        paymentDigest: record.paymentDigest,
        policyDigest: record.policyDigest,
        requestId,
        operatorId: OPERATOR_ID,
        verifiedAt: now,
      });
    } catch {
      return sendJson(res, 500, { error: "could not record approval" });
    }

    const approvedRecord = store.getRecord(requestId) ?? record;
    return sendJson(res, 200, {
      ...publicStatus(approvedRecord, provider, runtime.policy, nowFn()),
      alreadyApproved: false,
      paypalOrderId,
    });
  }

  async function reconcileAlreadyCaptured(
    record: PayPalPaymentRecord,
    res: ServerResponse,
  ): Promise<void> {
    const orderResult = await provider.getOrder(record.providerOrderId ?? "");
    if (!orderResult.ok) {
      try {
        store.recordUnknown(record.requestId, OPERATOR_ID);
      } catch {
        // State may already have changed; response still fails closed.
      }
      return sendJson(res, 409, {
        ok: false,
        state: "UNKNOWN",
        error: "PayPal reports the order already captured but verification failed",
        retryable: false,
        providerMode: provider.mode,
        simulated: provider.isMock,
      });
    }
    const capture = findPayPalCapture(orderResult.data, record.requestId);
    const verified = verifyCaptureResponse(orderResult.data, capture, record, provider.config.merchantId);
    if (!verified.ok || verified.capture === undefined) {
      try {
        store.recordUnknown(record.requestId, OPERATOR_ID);
      } catch {
        // Fail closed.
      }
      return sendJson(res, 409, {
        ok: false,
        state: "UNKNOWN",
        code: verified.code ?? "CAPTURE_VERIFICATION_FAILED",
        error: verified.message ?? "could not verify the existing capture",
        retryable: false,
        providerMode: provider.mode,
        simulated: provider.isMock,
      });
    }
    try {
      const completed = store.verifyCompletion(
        record.requestId,
        verified.capture.id,
        record.amountMinor,
        record.currency,
        OPERATOR_ID,
        record.receiver,
      );
      return sendJson(res, 200, {
        ...publicStatus(completed, provider, runtime.policy, nowFn()),
        duplicate: true,
      });
    } catch {
      return sendJson(res, 409, {
        ok: false,
        state: "UNKNOWN",
        error: "existing capture could not be recorded safely",
        retryable: false,
      });
    }
  }

  async function handleCapture(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAuthorized(req, runtime.operatorToken)) return sendJson(res, 401, { error: "unauthorized" });
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const unknown = rejectUnknownFields(body.value, ["requestId", "paypalOrderId"]);
    if (unknown !== null) return sendJson(res, 400, { error: unknown });
    const requestId = body.value["requestId"];
    const suppliedOrderId = body.value["paypalOrderId"];
    if (typeof requestId !== "string" || requestId.length === 0) return sendJson(res, 400, { error: "requestId is required" });
    if (suppliedOrderId !== undefined && (typeof suppliedOrderId !== "string" || suppliedOrderId.length === 0)) {
      return sendJson(res, 400, { error: "paypalOrderId must be a non-empty string" });
    }

    const record = store.getRecord(requestId);
    if (record === null) return sendJson(res, 404, { error: "payment not found" });
    if (record.providerOrderId === null) return sendJson(res, 409, { error: "payment has no bound PayPal order", state: record.state });
    if (typeof suppliedOrderId === "string" && suppliedOrderId !== record.providerOrderId) {
      return sendJson(res, 400, { error: "PayPal order does not match the reserved payment" });
    }

    if (record.state === "CAPTURED") {
      try {
        store.recordAudit(requestId, {
          eventType: "DUPLICATE_CAPTURE_REJECTED",
          state: "CAPTURED",
          message: "Duplicate capture request rejected; the verified capture was not repeated.",
          code: "DUPLICATE_CAPTURE",
          operatorId: OPERATOR_ID,
          providerOrderId: record.providerOrderId,
          captureId: record.captureId ?? undefined,
        });
      } catch {
        // The duplicate rejection below remains fail closed.
      }
      return sendJson(res, 409, {
        ok: false,
        state: "CAPTURED",
        error: "payment was already captured",
        duplicate: true,
        captureId: record.captureId,
        transactionReference: record.captureId,
        explanation: explainRecord(record),
      });
    }
    if (record.state === "UNKNOWN") {
      return sendJson(res, 409, {
        ok: false,
        state: "UNKNOWN",
        error: "capture outcome is unknown; automatic retry is disabled and manual reconciliation is required",
        retryable: false,
        explanation: explainRecord(record),
      });
    }
    if (record.state === "CAPTURING") {
      return sendJson(res, 409, { ok: false, state: "CAPTURING", error: "capture is already in progress", retryable: false });
    }
    if (record.state !== "APPROVED") {
      return sendJson(res, 400, { error: "payment must be APPROVED before capture", state: record.state });
    }
    if (record.approvalBinding === null) {
      return sendJson(res, 400, { error: "payment has no verified approval binding", state: record.state });
    }
    if (record.approvalBinding.paymentDigest !== record.paymentDigest) {
      return sendJson(res, 409, { error: "approval is not bound to the current payment digest", code: "PAYMENT_DIGEST_MISMATCH" });
    }
    if (record.approvalBinding.policyDigest !== record.policyDigest) {
      return sendJson(res, 409, { error: "approval is not bound to the current policy digest", code: "POLICY_DIGEST_MISMATCH" });
    }
    if (record.approvalBinding.requestId !== record.requestId) {
      return sendJson(res, 409, { error: "approval is not bound to this request id", code: "REQUEST_MISMATCH" });
    }

    const now = nowFn();
    if (record.policyDigest !== policyDigest) {
      try {
        store.recordFailure(requestId, "policy changed", OPERATOR_ID);
      } catch {
        // Fail closed below.
      }
      return sendJson(res, 409, { error: "policy changed after approval; start a new payment", code: "POLICY_CHANGED" });
    }
    if (record.paymentDigest !== computePayPalPaymentDigest(intentFromRecord(record))) {
      try {
        store.recordFailure(requestId, "payment digest changed", OPERATOR_ID);
      } catch {
        // Fail closed below.
      }
      return sendJson(res, 409, { error: "stored payment details were modified", code: "PAYMENT_DIGEST_MISMATCH" });
    }
    const decision = evaluatePayPalPolicy(intentFromRecord(record), runtime.policy, {
      now,
      humanApprovalVerified: true,
    });
    if (!decision.allowed) {
      try {
        store.recordFailure(requestId, "policy re-evaluation failed", OPERATOR_ID);
      } catch {
        // Fail closed below.
      }
      return sendJson(res, 400, {
        ok: false,
        error: "policy re-evaluation rejected the payment before capture",
        policy: { allowed: false, reasons: decision.reasons },
      });
    }

    try {
      store.transitionState(requestId, "CAPTURING", OPERATOR_ID);
    } catch {
      return sendJson(res, 409, { error: "payment could not enter CAPTURING state", state: record.state });
    }

    const captureResult = await provider.captureOrder(record.providerOrderId, record.amountMinor, requestId);
    if (!captureResult.ok) {
      if (captureResult.error.code === "ORDER_ALREADY_CAPTURED") {
        return reconcileAlreadyCaptured(record, res);
      }
      if (captureResult.error.ambiguous) {
        try {
          store.recordUnknown(requestId, OPERATOR_ID);
        } catch {
          // Fail closed: never retry an ambiguous outcome.
        }
        const unknownRecord = store.getRecord(requestId) ?? record;
        return sendJson(res, 502, {
          ...providerFailureBody(captureResult, "UNKNOWN"),
          retryable: false,
          explanation: explainRecord(unknownRecord),
        });
      }
      try {
        store.recordFailure(requestId, captureResult.error.message, OPERATOR_ID);
      } catch {
        // Response remains fail closed.
      }
      const failedRecord = store.getRecord(requestId) ?? record;
      return sendJson(res, 400, {
        ...providerFailureBody(captureResult, "FAILED"),
        retryable: false,
        explanation: explainRecord(failedRecord),
      });
    }

    const capture = findPayPalCapture(captureResult.data, requestId);
    const verified = verifyCaptureResponse(captureResult.data, capture, record, provider.config.merchantId);
    if (!verified.ok || verified.capture === undefined) {
      try {
        store.recordUnknown(requestId, OPERATOR_ID);
      } catch {
        // Fail closed.
      }
      const unknownRecord = store.getRecord(requestId) ?? record;
      return sendJson(res, 502, {
        ok: false,
        state: "UNKNOWN",
        code: verified.code ?? "CAPTURE_VERIFICATION_FAILED",
        error: verified.message ?? "capture evidence could not be verified",
        retryable: false,
        explanation: explainRecord(unknownRecord),
        providerMode: provider.mode,
        simulated: provider.isMock,
      });
    }

    let completed: PayPalPaymentRecord;
    try {
      completed = store.verifyCompletion(
        requestId,
        verified.capture.id,
        record.amountMinor,
        record.currency,
        OPERATOR_ID,
        record.receiver,
      );
    } catch {
      try {
        store.recordUnknown(requestId, OPERATOR_ID);
      } catch {
        // Fail closed.
      }
      return sendJson(res, 502, {
        ok: false,
        state: "UNKNOWN",
        error: "capture completed but could not be recorded safely; manual reconciliation required",
        retryable: false,
      });
    }

    return sendJson(res, 200, publicStatus(completed, provider, runtime.policy, nowFn()));
  }

  async function handlePaymentStatus(req: IncomingMessage, res: ServerResponse, paymentId: string): Promise<void> {
    const record = store.getRecord(paymentId);
    if (record === null) return sendJson(res, 404, { error: "payment not found" });
    return sendJson(res, 200, publicStatus(record, provider, runtime.policy, nowFn()));
  }

  async function handleAuditTrail(req: IncomingMessage, res: ServerResponse, paymentId: string): Promise<void> {
    if (!isAuthorized(req, runtime.operatorToken)) return sendJson(res, 401, { error: "unauthorized" });
    const record = store.getRecord(paymentId);
    if (record === null) return sendJson(res, 404, { error: "payment not found" });
    return sendJson(res, 200, {
      ok: true,
      paymentId,
      requestId: record.requestId,
      state: record.state,
      audit: store.getAuditTrail(paymentId),
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        providerMode: provider.mode,
        simulated: provider.isMock,
        operatorAuthRequired: runtime.operatorToken !== undefined,
        authMode,
      });
      return true;
    }
    if (pathname === "/api/paypal/extract" && req.method === "POST") {
      await handleExtract(req, res);
      return true;
    }
    if (pathname === "/api/paypal/intent" && req.method === "POST") {
      await handleCreateIntent(req, res);
      return true;
    }
    if (pathname === "/api/paypal/ai-extract" && req.method === "POST") {
      await handleAiExtract(req, res);
      return true;
    }
    if (pathname === "/api/paypal/order" && req.method === "POST") {
      await handleGetOrder(req, res);
      return true;
    }
    if (pathname.startsWith("/api/paypal/order/") && req.method === "GET") {
      const orderId = decodeURIComponent(pathname.slice("/api/paypal/order/".length));
      await handleGetOrder(req, res, orderId);
      return true;
    }
    if (pathname === "/api/paypal/approve" && req.method === "POST") {
      await handleApprove(req, res);
      return true;
    }
    if (pathname === "/api/paypal/capture" && req.method === "POST") {
      await handleCapture(req, res);
      return true;
    }
    if (pathname.startsWith("/api/paypal/payment/") && pathname.endsWith("/audit") && req.method === "GET") {
      const rawId = pathname.slice("/api/paypal/payment/".length, -"/audit".length);
      const paymentId = decodeURIComponent(rawId);
      if (paymentId.length === 0) {
        sendJson(res, 400, { error: "payment ID is required" });
      } else {
        await handleAuditTrail(req, res, paymentId);
      }
      return true;
    }
    if (pathname.startsWith("/api/paypal/payment/") && req.method === "GET") {
      const paymentId = decodeURIComponent(pathname.slice("/api/paypal/payment/".length));
      if (paymentId.length === 0) {
        sendJson(res, 400, { error: "payment ID is required" });
      } else {
        await handlePaymentStatus(req, res, paymentId);
      }
      return true;
    }
    if (pathname.startsWith("/api/paypal/") || pathname === "/health") {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    return false;
  }

  return {
    handle,
    close(): void {
      store.close();
    },
  };
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

let paypalServer: Server | null = null;
let paypalRouter: PayPalRequestHandler | null = null;

export function startPayPalServer(port: number = 3001, options: PayPalRouterOptions = {}): Server {
  const router = createPayPalRouter({
    ...options,
    store: options.store ?? createPayPalStore(":memory:"),
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const handled = await router.handle(req, res);
        if (!handled) sendJson(res, 404, { error: "not found" });
      } catch {
        sendJson(res, 500, { error: "internal error" });
      }
    })();
  });
  server.on("clientError", (_err: Error, socket) => {
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    } catch {
      // Socket already closed.
    }
    try {
      socket.destroy();
    } catch {
      // Already destroyed.
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(port, () => {
    const address = server.address();
    const actual = typeof address === "object" && address !== null ? String(address.port) : String(port);
    process.stdout.write(`PayPal API listening on port ${actual}\n`);
  });
  paypalServer = server;
  paypalRouter = router;
  return server;
}

export async function stopPayPalServer(): Promise<void> {
  const server = paypalServer;
  const router = paypalRouter;
  paypalServer = null;
  paypalRouter = null;
  if (server !== null) await closeServer(server);
  if (router !== null) router.close();
}
