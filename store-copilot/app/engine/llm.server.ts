import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

export type LlmResult = { text: string; inputTokens: number; outputTokens: number; ms: number };

export async function generate(opts: {
  system: string;
  prompt: string;
  maxTokens: number;
  jsonSchema?: unknown; // if set, the model must return JSON matching this schema
}): Promise<LlmResult> {
  const t0 = Date.now();
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: opts.prompt,
    config: {
      systemInstruction: opts.system,
      maxOutputTokens: opts.maxTokens,
      temperature: 0,
          ...(opts.jsonSchema !== undefined
        ? { responseMimeType: "application/json", responseJsonSchema: opts.jsonSchema }
        : {}),
    },
  });
  return {
    text: res.text ?? "",
    inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
    ms: Date.now() - t0,
  };
}
