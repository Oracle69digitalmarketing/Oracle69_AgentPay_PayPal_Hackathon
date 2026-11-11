/**
 * AI Configuration — lazy loading with fail-closed validation.
 *
 * Reads AI_* environment variables. Does NOT force unrelated routes to fail
 * when AI credentials are absent. Validation occurs when the interpreter
 * is invoked, not at module import time.
 */
export interface AIConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

/**
 * Supported AI providers and their model/configuration mappings.
 * OpenAI is the default but currently disabled (exhausted credits).
 * Groq and Gemini are alternative providers verified for payment extraction.
 */
export type AIProvider = "groq" | "gemini" | "openai";

/** Provider-specific model names. */
export const AI_MODEL_NAMES: Record<AIProvider, string> = {
  groq: "openai/gpt-oss-20b",
  gemini: "gemini-3.5-flash",
  openai: "gpt-4o-mini",
};

/** Provider-specific base URLs for API endpoints. */
export const AI_BASE_URLS: Record<AIProvider, string> = {
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
};

/** Provider-specific path segments for their respective endpoints. */
export const AI_ENDPOINT_PATHS: Record<AIProvider, string> = {
  groq: "chat/completions",
  gemini: "models/${MODEL}:generateContent",
  openai: "chat/completions",
};

/** Authentication header format per provider. */
export const AI_AUTH_FORMAT: Record<AIProvider, string> = {
  groq: "Bearer ",
  gemini: "X-Goog-Api-Key: ",
  openai: "Bearer ",
};

/**
 * Reads and validates AI configuration when the interpreter is invoked.
 * Returns the config object, or throws a descriptive error if any required
 * variable is missing. This function is idempotent — calling it multiple
 * times returns the same result.
 */
export function loadAIConfig(): AIConfig {
  const provider = process.env["AI_PROVIDER"] as AIProvider | undefined;
  const model = process.env["AI_MODEL_NAME"];
  const apiKey = process.env["AI_API_KEY"];
  const baseUrl = process.env["AI_BASE_URL"] ?? AI_BASE_URLS[provider ?? "openai"];

  if (!provider) {
    throw new Error("AI provider not configured: AI_PROVIDER environment variable is missing");
  }
  if (!Object.keys(AI_MODEL_NAMES).includes(provider)) {
    throw new Error(`Unsupported AI provider: ${provider}. Supported providers: groq, gemini, openai`);
  }
  if (!model) {
    throw new Error("AI model not configured: AI_MODEL_NAME environment variable is missing");
  }
  if (!apiKey) {
    throw new Error("AI API key not configured: AI_API_KEY environment variable is missing");
  }

  // Validate model matches provider
  if (AI_MODEL_NAMES[provider] !== model) {
    throw new Error(
      `Model ${model} does not match supported model for provider ${provider}: ${AI_MODEL_NAMES[provider]}`,
    );
  }

  return { provider, model, apiKey, baseUrl };
}

/**
 * Checks whether AI configuration is complete (for quick guard checks).
 * Does NOT throw; returns false if any required variable is missing or empty.
 */
export function hasAIConfig(): boolean {
  return (
    process.env["AI_PROVIDER"] !== undefined &&
    process.env["AI_PROVIDER"].length > 0 &&
    process.env["AI_MODEL_NAME"] !== undefined &&
    process.env["AI_MODEL_NAME"].length > 0 &&
    process.env["AI_API_KEY"] !== undefined &&
    process.env["AI_API_KEY"].length > 0
  );
}

/** Returns the model name for the given provider. */
export function getModelName(provider: AIProvider): string {
  return AI_MODEL_NAMES[provider];
}

/** Returns the base URL for the given provider. */
export function getBaseUrl(provider: AIProvider): string {
  return AI_BASE_URLS[provider];
}

/** Returns the auth header format for the given provider. */
export function getAuthHeader(provider: AIProvider): string {
  return AI_AUTH_FORMAT[provider];
}

export default { loadAIConfig, hasAIConfig, getModelName, getBaseUrl, getAuthHeader, AI_MODEL_NAMES, AI_BASE_URLS, AI_ENDPOINT_PATHS, AI_AUTH_FORMAT };