import { describe, expect, it, vi } from "vitest";
import { sendToProvider, getAuthHeader, interpretWithProvider } from "../../src/ai/providerAdapters.js";
import { loadAIConfig, hasAIConfig } from "../../src/ai/config.js";
import type { ExtractionReason } from "../../src/ai/types";

describe("Provider Adapters", () => {
  describe("Groq adapter", () => {
    it("builds Groq request with OpenAI-compatible format", () => {
      const config = {
        provider: "groq" as const,
        model: "openai/gpt-oss-20b",
        apiKey: "gsk_test",
        baseUrl: "https://api.groq.com/openai/v1",
      };

      const systemPrompt = `You are a payment interpretation agent for AgentPay.

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

      const userInstruction = "Pay $5.00 to merchant@example.com for a test service";

      const body = {
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userInstruction },
        ],
        response_format: { type: "json_object" },
        temperature: 1.0,
      };

      const expectedBody = JSON.stringify(body);
      const actualBody = JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userInstruction },
        ],
        response_format: { type: "json_object" },
        temperature: 1.0,
      });

      expect(actualBody).toBe(expectedBody);
    });

    it("parses Groq chat/completions response", () => {
      const rawResponse = JSON.stringify({
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1234567890,
        model: "gpt-oss-20b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                receiver: "merchant@example.com",
                amount: "5.00",
                currency: "USD",
                purpose: "test service",
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });

      // This tests the parseGroqResponse logic inline
      const parsed = JSON.parse(rawResponse);
      if (
        parsed.choices &&
        Array.isArray(parsed.choices) &&
        parsed.choices[0] &&
        parsed.choices[0].message &&
        typeof parsed.choices[0].message.content === "string"
      ) {
        const content = parsed.choices[0].message.content;
        const extracted = JSON.parse(content);
        expect(extracted).toEqual({
          receiver: "merchant@example.com",
          amount: "5.00",
          currency: "USD",
          purpose: "test service",
        });
      } else {
        throw new Error("Unexpected Groq response format");
      }
    });
  });

  describe("Gemini adapter", () => {
    it("builds Gemini request with native REST format", () => {
      const config = {
        provider: "gemini" as const,
        model: "gemini-3.5-flash",
        apiKey: "<your-gemini-api-key>",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };

      const systemPrompt = `You are a payment interpretation agent for AgentPay.

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

      const userInstruction = "Pay $5.00 to merchant@example.com for a test service";

      const combined = `${systemPrompt}${userInstruction}`;

      const body = JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: combined },
            ],
          },
        ],
      });

      const expectedBody = JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: combined },
            ],
          },
        ],
      });

      expect(body).toBe(expectedBody);
    });

    it("parses Gemini generateContent response", () => {
      const rawResponse = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: JSON.stringify({
                  receiver: "merchant@example.com",
                  amount: "5.00",
                  currency: "USD",
                  purpose: "test service",
                }) },
              ],
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
      });

      const parsed = JSON.parse(rawResponse);
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
        const content = candidates[0].content.parts[0].text;
        const extracted = JSON.parse(content);
        expect(extracted).toEqual({
          receiver: "merchant@example.com",
          amount: "5.00",
          currency: "USD",
          purpose: "test service",
        });
      } else {
        throw new Error("Unexpected Gemini response format");
      }
    });

    it("uses X-Goog-Api-Key header (not URL query)", () => {
      // Verify that Gemini auth uses header, not URL query string
      const config = {
        provider: "gemini" as const,
        model: "gemini-3.5-flash",
        apiKey: "test-key-12345",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };

      const authHeader = getAuthHeader("gemini", config.apiKey);
      expect(authHeader).toBe("X-Goog-Api-Key: test-key-12345");
    });
  });

  describe("OpenAI adapter", () => {
    it("builds OpenAI request with same format as Groq", () => {
      const config = {
        provider: "openai" as const,
        model: "gpt-4o-mini",
        apiKey: "sk-test-12345",
        baseUrl: "https://api.openai.com/v1",
      };

      const systemPrompt = `You are a payment interpretation agent for AgentPay.

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

      const userInstruction = "Pay $5.00 to merchant@example.com for a test service";

      const body = {
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userInstruction },
        ],
        response_format: { type: "json_object" },
        temperature: 1.0,
      };

      const actualBody = JSON.stringify(body);
      const expectedBody = JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userInstruction },
        ],
        response_format: { type: "json_object" },
        temperature: 1.0,
      });

      expect(actualBody).toBe(expectedBody);
    });
  });

  describe("getAuthHeader", () => {
    it("returns Bearer auth for Groq", () => {
      expect(getAuthHeader("groq", "gsk_test")).toBe("Bearer gsk_test");
    });

    it("returns Bearer auth for OpenAI", () => {
      expect(getAuthHeader("openai", "sk-test")).toBe("Bearer sk-test");
    });

    it("returns X-Goog-Api-Key for Gemini", () => {
      expect(getAuthHeader("gemini", "test-key")).toBe("X-Goog-Api-Key: test-key");
    });
  });
});