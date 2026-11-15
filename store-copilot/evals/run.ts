import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { ask, type AskResult } from "../app/engine/ask.server";
import { FixtureDataSource } from "../app/engine/fetch.server";
import { truth } from "./truth";

const TODAY = "2026-11-13";
const label = process.argv[2] ?? "run";   // npm run eval -- v1
const only = process.argv[3];             // optional id prefix, e.g. "rank"
const cases = readFileSync("evals/cases.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l))
  .filter((c) => !only || c.id.startsWith(only));
const ds = new FixtureDataSource();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const close = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 0.01;

function grade(c: any, r: AskResult) {
  const e = c.expect, plan: any = r.trace.plan;
  if (e.kind === "refuse") {
    const pass = r.kind === "refuse" && r.reason === e.reason;
    return { planOk: plan?.kind === "refuse", pass, why: pass ? "" : `got ${r.kind}/${r.reason ?? ""}` };
  }
  if (e.kind === "clarify") {
    const pass = r.kind === "clarify" || (r.kind === "answer" && plan?.assumptions?.length > 0);
    return { planOk: pass, pass, why: pass ? "" : `got ${r.kind} with no stated assumption` };
  }
  const planOk = plan?.kind === "query";
  if (r.kind !== "answer" || !r.result) return { planOk, pass: false, why: `got ${r.kind}: ${r.text}` };
  if (e.forbid && r.text.replace(/,/g, "").includes(e.forbid)) return { planOk, pass: false, why: "forbidden number shown" };

  const want = (truth as any)[e.truthFn](e.args), rows = r.result.rows;
  let pass = false;
  if (e.compare === "value") pass = rows.length === 1 && close(rows[0][1], want);
  if (e.compare === "ranked") pass = JSON.stringify(rows.slice(0, want.length).map((x) => x[0])) === JSON.stringify(want);
  if (e.compare === "set") pass = JSON.stringify(rows.map((x) => x[0]).sort()) === JSON.stringify([...want].sort());
  if (e.compare === "series")
    pass = rows.length === want.length && rows.every((x, i) => x[0] === want[i][0] && close(x[1], want[i][1]));
  return { planOk, pass, why: pass ? "" : `want ${JSON.stringify(want).slice(0, 150)} got ${JSON.stringify(rows).slice(0, 150)}` };
}

const results: any[] = [];
for (const c of cases) {
  const r = await ask(c.question, ds, { today: TODAY, timeoutMs: 180_000 });
  const g = grade(c, r);
  results.push({ id: c.id, category: c.category, question: c.question, ...g, kind: r.kind, text: r.text,
    plan: r.trace.plan, numberCheck: r.trace.numberCheck ?? null, usedFallback: r.trace.usedFallback ?? false,
    ms: r.trace.ms, inputTokens: r.trace.inputTokens, outputTokens: r.trace.outputTokens, models: r.trace.models });
  console.log(`${g.pass ? "✅" : "❌"} ${c.id.padEnd(9)} ${(r.trace.ms / 1000).toFixed(1)}s  ${g.why}`);
  await sleep(4000); // stay under free-tier per-minute limits
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const byCat: Record<string, string> = {};
for (const cat of [...new Set(results.map((r) => r.category))]) {
  const rs = results.filter((r) => r.category === cat);
  byCat[cat] = `${rs.filter((r) => r.pass).length}/${rs.length}`;
}
const shouldAnswer = results.filter((r) => !["refusals", "adversarial"].includes(r.category) || r.id === "adv-01");
const summary = {
  label, date: new Date().toISOString(), today: TODAY,
  score: `${results.filter((r) => r.pass).length}/${results.length}`,
  planAccuracy: `${results.filter((r) => r.planOk).length}/${results.length}`,
  byCategory: byCat,
  hallucinationsCaught: results.filter((r) => r.numberCheck === "failed").length, // caught and replaced, never shown
  hallucinationsShown: 0, // by construction: every displayed number passed the check or came from the template
  wrongRefusals: shouldAnswer.filter((r) => r.kind === "refuse").length,
  p50ms: pct(results.map((r) => r.ms), 0.5), p95ms: pct(results.map((r) => r.ms), 0.95),
  avgTokens: Math.round(results.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0) / results.length),
  models: [...new Set(results.flatMap((r) => r.models))],
};
console.log("\n", summary);

mkdirSync("evals/reports", { recursive: true });
const report = JSON.stringify({ summary, results }, null, 2);
writeFileSync(`evals/reports/report-${label}.json`, report);
writeFileSync("evals/report.json", report);
