/**
 * Provider adapters — handle provider-specific API request construction
 * and response parsing for the AgentPay AI payment interpretation service.
 *
 * Each adapter converts the common internal request format into the
 * provider's specific API format, and converts the provider's raw
 * response back into the normalized text for the interpreter to validate.
 *
 * CRITICAL: The AI output is NEVER trusted implicitly. All outputs are
 * validated server-side by parseAIResponse() and the deterministic
 * policy engine. These adapters only handle transport format conversion.
 */

import {
  AIProvider,
  AIConfig,
  loadAIConfig,
} from "./config.js";
import type {
  ExtractionReason,
  ExtractionResult,
  AIPaymentDetails,
} from "./types";

import {
  buildSystemPrompt,
  parseAIResponse,
  isValidAmountString,
  isValidCurrency,
  isValidReceiver,
} from "./payment-interpreter.js";

// --- Groq adapter -------------------------------------------------------

/**
 * Builds the Groq API request body from the common prompt+instruction format.
 * Groq uses the same OpenAI-compatible chat/completions format.
 */
function buildGroqRequest(config: AIConfig, systemPrompt: string, userInstruction: string): string {
  const body = {
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userInstruction },
    ],
    response_format: { type: "json_object" },
    temperature: 1.0,
  };
  return JSON.stringify(body);
}

/**
 * Parses the Groq API chat/completions response into normalized text.
 * Groq returns: { id, object, created, model, choices: [{ index, message: { role, content }, finish_reason }], usage }
 */
function parseGroqResponse(rawResponse: string): string {
  try {
    const parsed = JSON.parse(rawResponse);

    // Groq returns: { choices: [{ index, message: { role, content } }] }
    if (
      parsed.choices &&
      Array.isArray(parsed.choices) &&
      parsed.choices[0] &&
      parsed.choices[0].message &&
      typeof parsed.choices[0].message.content === "string"
    ) {
      return parsed.choices[0].message.content;
    }

    // Fallback: return the raw response as-is
    return rawResponse;
  } catch {
    return rawResponse;
  }
}

// --- Gemini adapter ------------------------------------------------------

/**
 * Builds the Gemini API request body from the common prompt+instruction format.
 * Gemini native REST uses: POST {baseUrl}/v1beta/models/{MODEL}:generateContent?key={API_KEY}
 * Request body: { "contents": [{"role": "user", "parts": [{"text": "..."}]}] }
 */
function buildGeminiRequest(
  config: AIConfig,
  systemPrompt: string,
  userInstruction: string,
): string {
  // Gemini expects the full prompt in the text part
  const combined = `${systemPrompt}${userInstruction}`;

  return JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          { text: combined },
        ],
      },
    ],
  });
}

/**
 * Parses the Gemini generateContent response into normalized text.
 * Gemini returns: { candidates: [{ content: { parts: [{ text }] }, finishReason, index }] }
 */
function parseGeminiResponse(rawResponse: string): string {
  try {
    const parsed = JSON.parse(rawResponse);

    // Navigate Gemini's response structure
    const candidates = parsed.candidates;
    if (
      candidates &&
      Array.isArray(candidates) &&
      candidates.length > 0 &&
      candidates[0].content &&
      candidates[0].content.parts &&
      Array.isArray(candidates[0].content.parts) &&
      candidates[0].content.parts.length > 0 &&
      typeof candidates[0].content.parts[0].text === "string"
    ) {
      return candidates[0].content.parts[0].text;
    }

    // Fallback
    return rawResponse;
  } catch {
    return rawResponse;
  }
}

// --- Auth header helper --------------------------------------------------

/**
 * Returns the authentication header string for the given provider.
 * Format: "HeaderName: value" or "Authorization: Bearer <key>"
 */
export function getAuthHeader(provider: AIProvider, apiKey: string): string {
  switch (provider) {
    case "groq":
    case "openai":
      return `Bearer ${apiKey}`;
    case "gemini":
      return `X-Goog-Api-Key: ${apiKey}`;
    default:
      return `Bearer ${apiKey}`;
  }
}

// --- Provider dispatch ---------------------------------------------------

/**
 * Sends a payment instruction to the configured AI provider and returns
 * the raw model response text. The caller is responsible for subsequent
 * JSON parsing and server-side validation via parseAIResponse().
 *
 * @param config The AI configuration (provider, model, apiKey, baseUrl)
 * @param userInstruction The natural-language payment instruction
 * @returns An object containing either the parsed response text or an error
 */
export async function sendToProvider(
  config: AIConfig,
  userInstruction: string,
): Promise<{
  success: true; rawText: string } | {
  success: false; reason: ExtractionReason; providerError: string;
}> {
  // 1. Determine provider
  const provider = config.provider as AIProvider | undefined;
  if (!provider) {
    return {
      success: false,
      reason: "CONFIGURATION_ERROR",
      providerError: "No provider specified in config",
    };
  }

  // 2. Build the system prompt (caller should provide this, but we build it here too)
  const systemPrompt = buildSystemPrompt();
  const instruction = userInstruction.trim();

  // 3. Construct API request based on provider
  let rawResponse: string;
  let parseResult: string;

  try {
    switch (provider) {
      case "groq": {
        const body = buildGroqRequest(config, systemPrompt, instruction);
        const baseUrl = config.baseUrl.replace(/\/+$/, "");
        const apiUrl = `${baseUrl}/chat/completions`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);

        const fetchResponse = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!fetchResponse.ok) {
          const errBody = await fetchResponse.text();
          return {
            success: false,
            reason: "NETWORK_ERROR",
            providerError: `Groq HTTP ${fetchResponse.status}: ${errBody.substring(0, 200)}`,
          };
        }

        rawResponse = await fetchResponse.text();
        parseResult = parseGroqResponse(rawResponse);
        break;
      }

      case "gemini": {
        const body = buildGeminiRequest(config, systemPrompt, instruction);
        const baseUrl = config.baseUrl.replace(/\/+$/, "");
        const apiUrl = `${baseUrl}/models/${config.model}:generateContent`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);

        const fetchResponse = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": config.apiKey,
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!fetchResponse.ok) {
          const errBody = await fetchResponse.text();
          return {
            success: false,
            reason: "NETWORK_ERROR",
            providerError: `Gemini HTTP ${fetchResponse.status}: ${errBody.substring(0, 200)}`,
          };
        }

        rawResponse = await fetchResponse.text();
        parseResult = parseGeminiResponse(rawResponse);
        break;
      }

      case "openai": {
        const body = buildGroqRequest(config, systemPrompt, instruction);
        const baseUrl = config.baseUrl.replace(/\/+$/, "");
        const apiUrl = `${baseUrl}/chat/completions`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);

        const fetchResponse = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!fetchResponse.ok) {
          const errBody = await fetchResponse.text();
          return {
            success: false,
            reason: "NETWORK_ERROR",
            providerError: `OpenAI HTTP ${fetchResponse.status}: ${errBody.substring(0, 200)}`,
          };
        }

        rawResponse = await fetchResponse.text();
        // OpenAI response format: the existing parseAIResponse in payment-interpreter.ts
        // will handle the JSON parsing. For sendToProvider, we just return the raw text.
        parseResult = rawResponse;
        break;
      }

      default:
        return {
          success: false,
          reason: "CONFIGURATION_ERROR",
          providerError: `Unsupported provider: ${provider}`,
        };
    }
  } catch (err: any) {
    // Network error, timeout, or fetch failure
    if (err.name === "AbortError") {
      return {
        success: false,
        reason: "TIMEOUT",
        providerError: "Request timed out after 30 seconds",
      };
    }
    return {
      success: false,
      reason: "NETWORK_ERROR",
      providerError: err.message || "Unknown network error",
    };
  }

  // 4. Return the parsed raw text for the interpreter to validate
  // If parseResult is empty or invalid, treat as JSON parse failure
  if (!parseResult || parseResult.length === 0) {
    return {
      success: false,
      reason: "INVALID_JSON",
      providerError: "Empty or missing response from provider",
    };
  }

  return {
    success: true,
    rawText: parseResult,
  };
}

/**
 * Sends a payment instruction to the configured AI provider, parses the
 * response, and validates the extraction result. Delegates to the
 * provider-specific logic (Groq, Gemini, or OpenAI) and returns a
 * validated ExtractionResult.
 *
 * The AI output is NEVER trusted implicitly. All outputs are validated
 * server-side against the same schemas used by the regex-based extraction
 * parser. The AI is an interpretation layer only — it never authorizes,
 * approves, or executes payments.
 */
export async function interpretWithProvider(
  instruction: string,
): Promise<ExtractionResult> {
  // 1. Load AI config
  let config: AIConfig;
  try {
    config = loadAIConfig();
  } catch {
    return { ok: false, reason: "CONFIGURATION_ERROR" };
  }

  // 2. Send to provider and get raw text
  const providerResult = await sendToProvider(config, instruction);
  if (!providerResult.success) {
    // Convert provider error to extraction reason
    return { ok: false, reason: providerResult.reason };
  }

  // 3. Parse and validate the AI response
  const parsed = parseAIResponse(providerResult.rawText);
  if ("reason" in parsed) {
    return { ok: false, reason: parsed.reason };
  }

  // 4. Return validated details
  return { ok: true, details: parsed.details };
}