/**
 * Natural-language payment instruction extraction.
 *
 * This is deliberately small and deterministic: no LLM, network, or clock.
 * It extracts only explicit USD amounts and PayPal receiver addresses. Any
 * ambiguity results in a structured error so the caller can ask the user to
 * be precise. Policy evaluation happens separately in the deterministic
 * PayPal engine.
 */
import { parseDecimalUsdToMinor } from "./validation.js";

export interface ExtractedPaymentInstruction {
  receiver: string;
  amountMinor: bigint;
  currency: "USD";
  purpose: string;
}

export interface InstructionExtractionFailure {
  ok: false;
  reasons: string[];
}

export interface InstructionExtractionSuccess {
  ok: true;
  value: ExtractedPaymentInstruction;
}

export type InstructionExtraction = InstructionExtractionSuccess | InstructionExtractionFailure;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PURPOSE_PATTERN = /\b(?:for|re|memo|invoice)\s+(.+?)(?:[.;]|$)/i;

function findAmount(instruction: string): string | null {
  const patterns = [
    /\$\s*([0-9]+(?:\.[0-9]{1,2})?)/,
    /\b([0-9]+(?:\.[0-9]{1,2})?)\s*(?:usd|dollars?)\b/i,
    /\busd\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    /\bpay\s+([0-9]+(?:\.[0-9]{1,2})?)\b/i,
  ];
  for (const pattern of patterns) {
    const match = instruction.match(pattern);
    if (match && typeof match[1] === "string") return match[1];
  }
  return null;
}

export function extractPaymentInstruction(input: unknown): InstructionExtraction {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, reasons: ["instruction must be a non-empty string"] };
  }
  if (input.length > 500) {
    return { ok: false, reasons: ["instruction is too long"] };
  }
  const instruction = input.replace(/\s+/g, " ").trim();

  const reasons: string[] = [];
  if (/\b(?:eur|gbp|jpy|cad|aud)\b/i.test(instruction) || /[€£¥]/.test(instruction)) {
    reasons.push("only USD payments are supported");
  }

  const receiverMatch = instruction.match(EMAIL_PATTERN);
  const receiver = receiverMatch?.[0] ?? null;
  if (receiver === null) {
    reasons.push("instruction must include a PayPal receiver email");
  }

  const amountText = findAmount(instruction);
  let amountMinor: bigint | null = null;
  if (amountText === null) {
    reasons.push("instruction must include an explicit USD amount");
  } else {
    try {
      amountMinor = parseDecimalUsdToMinor(amountText);
    } catch {
      reasons.push("instruction amount must be a valid USD amount with at most two decimal places");
    }
  }

  if (receiver === null || amountMinor === null || reasons.length > 0) {
    return { ok: false, reasons };
  }

  const purposeMatch = instruction.match(PURPOSE_PATTERN);
  let purpose = purposeMatch?.[1]?.trim() ?? "";
  if (purpose.length === 0) purpose = "AgentPay payment";
  if (purpose.length > 280) purpose = purpose.slice(0, 280);

  return {
    ok: true,
    value: { receiver, amountMinor, currency: "USD", purpose },
  };
}

/** AI-powered interpretation of a natural-language payment instruction.
 *
 *  Sends the instruction to a genuine AI model and returns a validated
  *  extraction result. The AI output is never trusted implicitly — every
 *  extraction is validated server-side against the same schemas used by the
 *  deterministic regex-based parser. The AI is an interpretation layer only;
 *  it never authorizes, approves, or executes payments.
 *
 *  If AI is unavailable (missing configuration, network error, model failure),
 *  the function returns an error result — NO automatic fallback to the
 *  regex parser occurs. The caller must decide whether to re-prompt the
 *  user, use the deterministic parser, or abort.
 *
 *  The output schema contains exactly: receiver, amount, currency, purpose.
 *  The model must NOT include fields such as "approved", "authorized",
 *  "execute", "capture", "payment_state", "policy_result", or "bypass_policy".
 *
 *  @param instruction The natural-language payment instruction.
 *  @returns An ExtractionResult containing either the extracted details
 *           or a classified error reason.
 */
import { interpretPaymentInstruction } from "../ai/payment-interpreter.js";

export async function aiInterpret(instruction: string): Promise<import("../ai/types").ExtractionResult> {
  return await interpretPaymentInstruction(instruction);
}
