/**
 * AI Payment Interpretation Service
 *
 * Sends natural-language payment instructions to a genuine AI model and
 * validates the structured output. All financial policy decisions remain
 * the sole responsibility of the existing deterministic policy engine.
 *
 * CRITICAL: AI output is NEVER trusted implicitly. Every extraction is
 * validated server-side against the same schemas used by the regex-based
 * extraction parser. The AI is an interpretation layer only — it never
 * authorizes, approves, or executes payments.
 *
 * AI FAILURE IS FAIL-CLOSED: if the AI endpoint is called and the AI model
 * is unavailable or returns invalid output, no AI-derived payment intent
 * proceeds. The endpoint returns a clear error; the existing non-AI routes
 * continue to operate independently.
 */
import { loadAIConfig, hasAIConfig, AIProvider } from "./config.js";
import type { AIConfig } from "./config.js";
import type {
  AIPaymentDetails,
  ExtractionReason,
  ExtractionResult,
} from "./types";
import {
  interpretWithProvider,
} from "./providerAdapters.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_INSTRUCTION_LENGTH = 1_000;

const UNSUPPORTED_CURRENCIES = ["EUR", "GBP", "JPY", "CAD", "AUD"];

const UNAUTHORIZED_OUTPUT_FIELDS = new Set([
  "approved",
  "authorized",
  "execute",
  "capture",
  "payment_state",
  "policy_result",
  "bypass_policy",
]);

/** Constructs the system prompt that constrains the AI's output format. */
export function buildSystemPrompt(): string {
  return `You are a payment interpretation agent for AgentPay.

Your task is to extract exactly four fields from the user's natural-language payment instruction:

- receiver: a PayPal email address or payer-id
- amount: a decimal string in USD (e.g. "5.00")
- currency: always "USD"
- purpose: a brief description of the payment purpose

Output NOTHING EXCEPT a JSON object with exactly these four fields:
{"receiver": <value>, "amount": <value>, "currency": <value>, "purpose": <value>}

Do not include any other text, reasoning, or fields. Do not include fields such as
"approved", "authorized", "execute", "capture", "payment_state", "policy_result", or
"bypass_policy". If any field cannot be determined, use null for that field.

User instruction:`;
}

/** Validates that the AI returned output contains only authorized fields. */
function hasUnauthorizedFields(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((key) => UNAUTHORIZED_OUTPUT_FIELDS.has(key.toLowerCase()));
}

/** Validates that the amount string is a proper decimal USD amount. */
export function isValidAmountString(amount: string): boolean {
  // Must be a non-empty decimal string, optionally with exactly 2 decimal places
  if (amount.length === 0) return false;
  // Allow "5" or "5.00" or "5.50" but not "5.5" (1 decimal) or "5.001" (3 decimals)
  const parts = amount.split(".");
  const integerPart = parts[0] ?? "";
  const fraction = parts[1];
  // Reject empty integer part (e.g. ".5") or purely fractional without integer
  if (integerPart.length === 0) return false;
  if (fraction !== undefined) {
    if (fraction.length > 2) return false; // too many decimal places
    // Don't allow leading zeros except for "0.00" style
    if (integerPart !== "0" && integerPart.startsWith("0")) return false;
  } else {
    // No decimal point - must be a positive integer string
    // integerPart is guaranteed to have length >= 1 from the check above
    if (integerPart === "0") return false; // 0 is not a valid amount
    if (integerPart.startsWith("0")) return false; // leading zero
  }
  // Reject scientific notation, signs, etc. (shouldn't reach here if JSON is valid)
  return /^\d+(\.\d{1,2})?$/.test(amount);
}

/** Validates that the currency is "USD". */
export function isValidCurrency(currency: string): boolean {
  return currency === "USD";
}

/** Validates that the receiver is a non-empty string. */
export function isValidReceiver(receiver: string): boolean {
  return typeof receiver === "string" && receiver.trim().length > 0;
}

/** Parses the AI model's JSON response and validates the extraction. */
export function parseAIResponse(
  rawResponse: string,
): { details: AIPaymentDetails } | { reason: ExtractionReason } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawResponse);
  } catch {
    return { reason: "INVALID_JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { reason: "INVALID_SCHEMA" };
  }

  // Check for unauthorized fields
  if (hasUnauthorizedFields(parsed)) {
    return { reason: "INVALID_SCHEMA" };
  }

  // Extract the four required fields, tolerating null/undefined
  const receiver = parsed.receiver;
  const amount = parsed.amount;
  const currency = parsed.currency;
  const purpose = parsed.purpose;

  // Validate receiver
  if (!isValidReceiver(receiver as string)) {
    return { reason: "MISSING_RECEIVER" };
  }

  // Validate amount
  const amountStr = amount as string;
  if (amountStr === null || typeof amountStr !== "string" || !isValidAmountString(amountStr)) {
    return { reason: "MISSING_AMOUNT" };
  }

  // Validate currency
  const currencyStr = currency as string;
  if (currencyStr === null || typeof currencyStr !== "string" || !isValidCurrency(currencyStr)) {
    return { reason: "UNSUPPORTED_CURRENCY" };
  }

  // Validate purpose
  const purposeStr = purpose as string;
  if (purposeStr === null || typeof purposeStr !== "string" || purposeStr.trim().length === 0) {
    // Purpose can be null per the prompt, but if provided must be non-empty
    // We'll accept null purpose and replace it later
    // Actually, let's require non-null purpose for now
    return { reason: "INVALID_SCHEMA" };
  }

  const details: AIPaymentDetails = {
    receiver: receiver as string,
    amount: amount as string,
    currency: currencyStr,
    purpose: purposeStr.trim(),
  };

  return { details };
}

/**
 * Sends a payment instruction to the configured AI provider and returns
 * the validated extraction result. Delegates to the provider-specific
 * adapter (Groq, Gemini, or OpenAI) based on config.provider.
 *
 * @param instruction The natural-language payment instruction.
 * @returns A validated ExtractionResult containing either the extracted details
 *          or a classified error reason.
 *
 * Throws if AI configuration is missing. The caller should catch this and
 * return an appropriate error response rather than crashing.
 */
export async function interpretPaymentInstruction(
  instruction: string,
): Promise<ExtractionResult> {
  // 1. Validate input
  if (typeof instruction !== "string" || instruction.trim().length === 0) {
    return { ok: false, reason: "MISSING_RECEIVER" }; // reuse reason category
  }
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    return { ok: false, reason: "INVALID_SCHEMA" }; // instruction too long
  }

  // 2. Check AI config
  let config: import("./config.js").AIConfig;
  try {
    config = loadAIConfig();
  } catch {
    return { ok: false, reason: "CONFIGURATION_ERROR" };
  }

  // 3. Delegate to provider-specific interpreter
  // This handles Groq (OpenAI-compatible), Gemini (native REST), or OpenAI
  return await interpretWithProvider(instruction.trim());
}

/** Simple guard: returns true only if AI config is fully present. */
export { hasAIConfig };

// Re-export commonly used types and helpers for convenience
export type {
  AIProvider,
  AIConfig,
  ExtractionReason,
  ExtractionResult,
  AIPaymentDetails,
};