import { ApiError, GoogleGenAI } from "@google/genai";
import type { Message } from "./store.js";

// The model behind the chat. GeminiClient is used in production; tests pass a fake.
export interface LlmClient {
  // Yields the reply as it is generated. Stops early when `signal` aborts.
  stream(context: Message[], prompt: string, signal: AbortSignal): AsyncGenerator<string>;
}

// Thrown for any failure that comes from the model provider, with the provider's status.
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

const SYSTEM_INSTRUCTION =
  "You are a helpful assistant in a web chat. Answer clearly and briefly, use plain text, and say so when you don't know something.";

export class GeminiClient implements LlmClient {
  private ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private model: string,
    private maxOutputTokens: number,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async *stream(context: Message[], prompt: string, signal: AbortSignal): AsyncGenerator<string> {
    const contents = [
      ...context.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
      { role: "user" as const, parts: [{ text: prompt }] },
    ];

    let chunks: AsyncGenerator<{ text?: string | undefined }>;
    try {
      chunks = await this.ai.models.generateContentStream({
        model: this.model,
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          maxOutputTokens: this.maxOutputTokens,
          abortSignal: signal,
        },
      });
    } catch (err) {
      throw toUpstream(err);
    }

    try {
      for await (const chunk of chunks) {
        if (chunk.text) yield chunk.text;
      }
    } catch (err) {
      if (signal.aborted) return;
      throw toUpstream(err);
    }
  }
}

function toUpstream(err: unknown): UpstreamError {
  if (err instanceof ApiError) return new UpstreamError(err.message, err.status);
  return new UpstreamError(err instanceof Error ? err.message : "Unknown model error", undefined);
}
