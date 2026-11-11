/**
 * AI Payment Interpretation — types for the AgentPay AI service.
 *
 * Defines the extraction result schema, error categories, and config types.
 * All amounts are decimal strings (e.g. "5.00") — the server converts to
 * integer cents via the existing strict monetary parser. No floating-point
 * arithmetic is ever used for financial calculations.
 */
export interface AIPaymentDetails {
  /** PayPal receiver email or payer-id. */
  receiver: string;
  /** Amount as decimal string in USD, e.g. "5.00". */
  amount: string;
  /** Currency code — always "USD". */
  currency: string;
  /** Brief purpose description. */
  purpose: string;
}

/** Error categories for AI interpretation failures. */
export type ExtractionReason =
  | "CONFIGURATION_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "MODEL_REFUSAL"
  | "INVALID_JSON"
  | "INVALID_SCHEMA"
  | "MISSING_RECEIVER"
  | "MISSING_AMOUNT"
  | "UNSUPPORTED_CURRENCY";

/** Result of AI-powered payment instruction interpretation. */
export type ExtractionResult =
  | { ok: true; details: AIPaymentDetails }
  | { ok: false; reason: ExtractionReason };