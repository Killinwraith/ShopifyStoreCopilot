// One record per pipeline step, so a failed run can be traced to the exact point of failure.
export type StepName = "plan" | "fetch" | "aggregate" | "answer" | "error";
export type Step = { step: StepName; ok: boolean; ms: number } & Record<string, unknown>;

export type LlmAttempt = { model: string; attempt: number; ok: boolean; status?: number; error?: string; ms: number };
