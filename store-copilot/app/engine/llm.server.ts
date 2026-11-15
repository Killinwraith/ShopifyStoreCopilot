import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { LlmAttempt } from "./trace";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: 30_000 } });

// First model that answers wins. Override the first choice with GEMINI_MODEL in .env.
const MODELS = [
  ...new Set([process.env.GEMINI_MODEL, "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]),
].filter(Boolean) as string[];
export const MODEL_CHAIN = MODELS;

const RETRYABLE = [429, 500, 503, 504];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LlmResult = {
  text: string; model: string; inputTokens: number; outputTokens: number; ms: number; truncated: boolean;
  attempts: LlmAttempt[]; // every model/attempt tried, including failures
};

export async function generate(opts: {
  system: string;
  prompt: string;
  maxTokens: number;
  jsonSchema?: unknown; // if set, the model must return JSON matching this schema
}): Promise<LlmResult> {
  const t0 = Date.now();
  let lastErr: unknown;
  const attempts: LlmAttempt[] = [];

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ta = Date.now();
      try {
        const res = await ai.models.generateContent({
          model,
          contents: opts.prompt,
          config: {
            systemInstruction: opts.system,
            maxOutputTokens: opts.maxTokens,
            temperature: 0,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }, // thinking tokens count against maxOutputTokens
            ...(opts.jsonSchema !== undefined
              ? { responseMimeType: "application/json", responseJsonSchema: opts.jsonSchema }
              : {}),
          },
        });
        const text = res.text ?? "";
        if (!text) throw Object.assign(new Error(`Empty response from ${model}`), { status: 500 });
        attempts.push({ model, attempt: attempt + 1, ok: true, ms: Date.now() - ta });
        return {
          attempts,
          text,
          model,
          inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
          ms: Date.now() - t0,
          truncated: res.candidates?.[0]?.finishReason === "MAX_TOKENS",
        };
      } catch (e: any) {
        attempts.push({ model, attempt: attempt + 1, ok: false, status: e?.status,
          error: String(e?.message).slice(0, 300), ms: Date.now() - ta });
        console.warn(`[llm] ${model} attempt ${attempt + 1}: ${e?.status ?? ""} ${String(e?.message).slice(0, 120)}`);
        if (e?.status === 404) break; // model unavailable: try the next one, keep the real error
        lastErr = e;
        if (!RETRYABLE.includes(e?.status) && !String(e?.message).includes("timed out")) throw Object.assign(e, { attempts });
        await sleep(5000 * 3 ** attempt); // 5s, then 15s (free-tier per-minute limits)
      }
    }
  }
  throw Object.assign((lastErr as Error) ?? new Error("No model available"), { attempts });
}
