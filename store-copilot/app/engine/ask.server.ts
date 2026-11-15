import { makePlan } from "./planner.server";
import { toRequest } from "./queries";
import { aggregate, localDate, UnsupportedPlan, type Result } from "./aggregate";
import { writeAnswer } from "./answer.server";
import type { DataSource } from "./fetch.server";
import type { Plan } from "./plan";
import type { Step } from "./trace";

const REFUSALS = {
  write_action: "I'm read-only, so I can't change anything in your store. You can do that in the Shopify admin under Orders or Products.",
  customer_pii: "I don't share customers' personal details. You can see customer records in the Shopify admin under Customers.",
  off_topic: "I can only answer questions about this store's sales, products and inventory.",
  unsupported: "I can't answer that from order and inventory data. Try the Shopify admin under Analytics.",
} as const;

export type Trace = {
  plan?: Plan; template?: string; variables?: object; pages?: number; queryCost?: number; capped?: boolean;
  numberCheck?: "passed" | "failed"; usedFallback?: boolean; models: string[];
  inputTokens: number; outputTokens: number; ms: number; planAttempts?: number;
  today?: string; timezone?: string;
  steps: Step[]; // every step in order: plan attempts, fetch, aggregate, answer, error
};
export type AskResult = {
  kind: "answer" | "refuse" | "clarify" | "error";
  text: string; reason?: string; result?: Result; trace: Trace;
};

// At most 10 questions a minute per shop. In memory, which is fine for a demo.
const hits = new Map<string, number[]>();
export function rateLimited(shop: string): boolean {
  const now = Date.now();
  const recent = (hits.get(shop) ?? []).filter((t) => now - t < 60_000);
  recent.push(now); hits.set(shop, recent);
  return recent.length > 10;
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

export async function ask(question: string, ds: DataSource, opts: { today?: string; timeoutMs?: number } = {}): Promise<AskResult> {
  const t0 = Date.now();
  const trace: Trace = { models: [], inputTokens: 0, outputTokens: 0, ms: 0, steps: [] };
  const done = (r: Omit<AskResult, "trace">): AskResult => ({ ...r, trace: { ...trace, ms: Date.now() - t0 } });

  if (!question.trim() || question.length > 500) return done({ kind: "error", text: "Please ask a question under 500 characters." });

  try {
    return await withTimeout((async () => {
      const tz = await ds.timezone();
      const today = opts.today ?? localDate(new Date().toISOString(), tz);
      Object.assign(trace, { today, timezone: tz });

      const p = await makePlan(question, { today, timezone: tz });
      trace.steps.push(...p.steps);
      Object.assign(trace, { plan: p.plan ?? undefined, planAttempts: p.attempts });
      trace.inputTokens += p.inputTokens; trace.outputTokens += p.outputTokens;
      if (p.model) trace.models.push(p.model);

      if (!p.plan) return done({ kind: "error", text: "I couldn't understand that. Try rephrasing, e.g. \"Total sales last week\"." });
      if (p.plan.kind === "refuse") return done({ kind: "refuse", reason: p.plan.reason, text: REFUSALS[p.plan.reason] });
      if (p.plan.kind === "clarify") return done({ kind: "clarify", text: p.plan.question });

      const plan = p.plan;
      const req = toRequest(plan);
      const tf = Date.now();
      const f = await ds.fetchAll(req.template, req.q);
      Object.assign(trace, { template: f.template, variables: f.variables, pages: f.pages, queryCost: f.cost, capped: f.capped });
      trace.steps.push({ step: "fetch", ok: true, ms: Date.now() - tf, template: f.template, variables: f.variables,
        pages: f.pages, queryCost: f.cost, capped: f.capped, rowCount: f.rows.length });

      let result: Result;
      const tg = Date.now();
      try {
        result = aggregate(plan, f.rows, tz);
        trace.steps.push({ step: "aggregate", ok: true, ms: Date.now() - tg, columns: result.columns,
          rowCount: result.rows.length, rows: result.rows.slice(0, 50) });
      } catch (e: any) {
        trace.steps.push({ step: "aggregate", ok: false, ms: Date.now() - tg, error: String(e?.message),
          unsupported: e instanceof UnsupportedPlan });
        if (e instanceof UnsupportedPlan) return done({ kind: "refuse", reason: "unsupported", text: REFUSALS.unsupported });
        throw e;
      }

      const a = await writeAnswer(question, plan, result);
      trace.steps.push(a.step);
      Object.assign(trace, { numberCheck: a.numberCheck, usedFallback: a.usedFallback });
      trace.inputTokens += a.inputTokens; trace.outputTokens += a.outputTokens;
      if (a.model) trace.models.push(a.model);

      const note = f.capped ? " (Note: I hit the 20-page limit, so this may be incomplete.)" : "";
      return done({ kind: "answer", text: a.text + note, result });
    })(), opts.timeoutMs ?? 30_000);
  } catch (e: any) {
    trace.steps.push(...(e?.steps ?? []), { step: "error", ok: false, ms: Date.now() - t0,
      error: String(e?.message).slice(0, 500), status: e?.status, llmAttempts: e?.attempts,
      stack: e?.stack?.split("\n").slice(0, 5).join("\n") });
    return done({ kind: "error", text: e?.message === "timeout" ? "That took too long. Please try again." : "Something went wrong. Please try again." });
  }
}
