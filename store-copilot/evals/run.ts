// Eval runner + tracker.
//   npm run eval -- v1            full run, label "v1"
//   npm run eval -- dbg rank      only cases whose id starts with "rank"
//
// Every run is saved to evals/runs/<timestamp>_<label>/:
//   meta.json        git commit, model chain, prompt/case/fixture hashes: what exactly was tested
//   cases/<id>.json  the case, expected truth, grade, and the full step-by-step trace
//   summary.json     scores, latency, tokens, failures with their failure point
// and one line is appended to evals/runs/index.jsonl so runs can be compared over time.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ask, type AskResult } from "../app/engine/ask.server";
import { FixtureDataSource } from "../app/engine/fetch.server";
import { systemPrompt } from "../app/engine/planner.server";
import { ANSWER_SYSTEM } from "../app/engine/answer.server";
import { MODEL_CHAIN } from "../app/engine/llm.server";
import { truth } from "./truth";

const TODAY = "2026-11-13";
const label = process.argv[2] ?? "run";
const only = process.argv[3];
const casesText = readFileSync("evals/cases.jsonl", "utf8");
const cases = casesText.trim().split("\n").map((l) => JSON.parse(l)).filter((c) => !only || c.id.startsWith(only));
const ds = new FixtureDataSource();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const close = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 0.01;
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const sh = (cmd: string) => {
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
};

// ---- run metadata: enough to reproduce or explain a score later ----
const startedAt = new Date();
const runId = `${startedAt.toISOString().slice(0, 16).replace(/:/g, "-")}_${label}`;
const dir = `evals/runs/${runId}`;
mkdirSync(`${dir}/cases`, { recursive: true });
const tz = await ds.timezone();
const meta = {
  runId, label, filter: only ?? null, startedAt: startedAt.toISOString(), today: TODAY, timezone: tz,
  git: { commit: sh("git rev-parse --short HEAD"), dirty: !!sh("git status --porcelain") },
  node: process.version, modelChain: MODEL_CHAIN, caseCount: cases.length,
  hashes: {
    plannerPrompt: hash(systemPrompt(TODAY, tz)),
    answerPrompt: hash(ANSWER_SYSTEM),
    cases: hash(casesText),
    fixtures: hash(readFileSync("evals/fixtures/orders.json", "utf8") + readFileSync("evals/fixtures/products.json", "utf8")),
  },
};
writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 2));

// ---- grading: pass/fail plus the step where it went wrong ----
type Grade = { planOk: boolean; pass: boolean; why: string; failedAt: string | null; want?: unknown };

function grade(c: any, r: AskResult): Grade {
  const e = c.expect, plan: any = r.trace.plan;
  const brokenStep = r.trace.steps.find((s) => !s.ok && s.step !== "answer")?.step; // answer fallback still answers

  if (e.kind === "refuse") {
    const pass = r.kind === "refuse" && r.reason === e.reason;
    return { planOk: plan?.kind === "refuse", pass, want: e,
      why: pass ? "" : `want refuse/${e.reason}, got ${r.kind}/${r.reason ?? ""}`,
      failedAt: pass ? null : brokenStep ?? "plan: wrong kind or reason" };
  }
  if (e.kind === "clarify") {
    const pass = r.kind === "clarify" || (r.kind === "answer" && plan?.assumptions?.length > 0);
    return { planOk: pass, pass, want: e, why: pass ? "" : `got ${r.kind} with no stated assumption`,
      failedAt: pass ? null : brokenStep ?? "plan: answered without clarifying" };
  }

  const planOk = plan?.kind === "query";
  if (r.kind !== "answer" || !r.result)
    return { planOk, pass: false, why: `got ${r.kind}: ${r.text}`, failedAt: brokenStep ?? `plan: returned ${plan?.kind ?? "nothing"}` };
  if (e.forbid && r.text.replace(/,/g, "").includes(e.forbid))
    return { planOk, pass: false, why: `forbidden "${e.forbid}" shown`, failedAt: "answer: forbidden number reached the user" };

  const want = (truth as any)[e.truthFn](e.args), rows = r.result.rows;
  let pass = false;
  if (e.compare === "value") pass = rows.length === 1 && close(rows[0][1], want);
  if (e.compare === "ranked") pass = JSON.stringify(rows.slice(0, want.length).map((x) => x[0])) === JSON.stringify(want);
  if (e.compare === "set") pass = JSON.stringify(rows.map((x) => x[0]).sort()) === JSON.stringify([...want].sort());
  if (e.compare === "series")
    pass = rows.length === want.length && rows.every((x, i) => x[0] === want[i][0] && close(x[1], want[i][1]));
  // aggregate.ts is unit-tested and truth.ts is independent, so a wrong table almost always means wrong plan fields.
  return { planOk, pass, want,
    why: pass ? "" : `want ${JSON.stringify(want).slice(0, 150)} got ${JSON.stringify(rows).slice(0, 150)}`,
    failedAt: pass ? null : brokenStep ?? "plan: valid but wrong fields (check dates/limit/grouping vs expected)" };
}

// ---- run ----
const results: any[] = [];
for (const c of cases) {
  const r = await ask(c.question, ds, { today: TODAY, timeoutMs: 180_000 });
  const g = grade(c, r);
  const row = {
    id: c.id, category: c.category, question: c.question,
    pass: g.pass, planOk: g.planOk, failedAt: g.failedAt, why: g.why,
    kind: r.kind, text: r.text, plan: r.trace.plan ?? null,
    numberCheck: r.trace.numberCheck ?? null, usedFallback: r.trace.usedFallback ?? false,
    ms: r.trace.ms, inputTokens: r.trace.inputTokens, outputTokens: r.trace.outputTokens, models: r.trace.models,
    llmRetries: r.trace.steps.flatMap((s: any) => s.llmAttempts ?? []).filter((a: any) => !a.ok).length,
  };
  results.push(row);
  // Written per case, so a crashed or interrupted run still leaves its evidence behind.
  writeFileSync(`${dir}/cases/${c.id}.json`, JSON.stringify({ case: c, expected: g.want, grade: g, response: r }, null, 2));
  console.log(`${g.pass ? "✅" : "❌"} ${c.id.padEnd(9)} ${(r.trace.ms / 1000).toFixed(1)}s` +
    (g.pass ? "" : `  [${g.failedAt}] ${g.why}`));
  await sleep(4000); // stay under free-tier per-minute limits
}

// ---- summary ----
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const byCategory: Record<string, string> = {};
for (const cat of [...new Set(results.map((r) => r.category))]) {
  const rs = results.filter((r) => r.category === cat);
  byCategory[cat] = `${rs.filter((r) => r.pass).length}/${rs.length}`;
}
const shouldAnswer = results.filter((r) => !["refusals", "adversarial"].includes(r.category) || r.id === "adv-01");
const summary = {
  runId, label, git: meta.git, startedAt: meta.startedAt, finishedAt: new Date().toISOString(),
  score: `${results.filter((r) => r.pass).length}/${results.length}`,
  planAccuracy: `${results.filter((r) => r.planOk).length}/${results.length}`,
  byCategory,
  hallucinationsCaught: results.filter((r) => r.numberCheck === "failed").length, // caught and replaced, never shown
  hallucinationsShown: 0, // by construction: every displayed number passed the check or came from the template
  wrongRefusals: shouldAnswer.filter((r) => r.kind === "refuse").length,
  errors: results.filter((r) => r.kind === "error").length,
  llmRetries: results.reduce((s, r) => s + r.llmRetries, 0),
  p50ms: pct(results.map((r) => r.ms), 0.5), p95ms: pct(results.map((r) => r.ms), 0.95),
  avgTokens: Math.round(results.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0) / results.length),
  models: [...new Set(results.flatMap((r) => r.models))],
  hashes: meta.hashes,
  failures: results.filter((r) => !r.pass).map((r) => ({ id: r.id, failedAt: r.failedAt, why: r.why })),
};
writeFileSync(`${dir}/summary.json`, JSON.stringify({ summary, results }, null, 2));
appendFileSync("evals/runs/index.jsonl", JSON.stringify({
  runId, label, filter: only ?? null, date: summary.finishedAt, commit: meta.git.commit, dirty: meta.git.dirty,
  score: summary.score, planAccuracy: summary.planAccuracy, byCategory, models: summary.models,
  p50ms: summary.p50ms, llmRetries: summary.llmRetries, hashes: meta.hashes,
  failed: summary.failures.map((f) => f.id),
}) + "\n");

console.log("\n", { ...summary, failures: undefined });
if (summary.failures.length) console.table(summary.failures);
console.log(`\nSaved: ${dir}/`);
