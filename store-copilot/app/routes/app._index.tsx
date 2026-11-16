import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ask, rateLimited, type AskResult } from "../engine/ask.server";
import { ShopifyDataSource } from "../engine/fetch.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

// Runs on the server only: the Gemini key and all model calls never reach the browser.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const question = String((await request.formData()).get("question") ?? "").trim();
  if (rateLimited(session.shop)) {
    const r: AskResult = { kind: "error", text: "That's more than 10 questions this minute. Please wait a moment.",
      trace: { models: [], inputTokens: 0, outputTokens: 0, ms: 0, steps: [] } };
    return { ...r, question };
  }
  const ds = new ShopifyDataSource(async (query, variables) => (await admin.graphql(query, { variables })).json());
  return { ...(await ask(question, ds)), question };
};

const SUGGESTED = [
  "Sales last 7 days",
  "Top 5 products by revenue this month",
  "Which products have under 10 units left?",
  "Orders per day, last 14 days",
];
const MONEY = new Set(["revenue", "average order value", "price"]);
const fmt = (col: string, v: string | number) =>
  typeof v !== "number" ? v
  : MONEY.has(col) ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : v.toLocaleString("en-US");

type Data = AskResult & { question: string };

export default function Index() {
  const fetcher = useFetcher<typeof action>();
  const [question, setQuestion] = useState("");
  const loading = fetcher.state !== "idle";

  const submit = (q: string) => {
    if (!q.trim() || loading) return;
    setQuestion(q);
    fetcher.submit({ question: q }, { method: "POST" });
  };

  return (
    <s-page heading="Store Copilot">
      <s-section>
        <s-stack gap="base">
          <s-paragraph>Read-only. Every number is computed from your store data.</s-paragraph>
          <form onSubmit={(e) => { e.preventDefault(); submit(question); }}>
            <s-stack gap="base">
              <s-text-field
                label="Ask about your sales, products or inventory"
                name="question"
                value={question}
                placeholder="e.g. Top 5 products by revenue this month"
                onInput={(e) => setQuestion(e.currentTarget.value ?? "")}
              />
              <s-stack direction="inline" gap="base">
                <s-button variant="primary" type="submit" loading={loading}>Ask</s-button>
                {SUGGESTED.map((q) => (
                  <s-button key={q} onClick={() => submit(q)} disabled={loading}>{q}</s-button>
                ))}
              </s-stack>
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      {fetcher.data && !loading && <ResultView r={fetcher.data as Data} onAsk={submit} />}
    </s-page>
  );
}

function ResultView({ r, onAsk }: { r: Data; onAsk: (q: string) => void }) {
  if (r.kind === "refuse")
    return (
      <s-section>
        <s-banner tone="warning" heading="I can't do that">{r.text}</s-banner>
      </s-section>
    );

  if (r.kind === "error")
    return (
      <s-section>
        <s-stack gap="base">
          <s-banner tone="critical">{r.text}</s-banner>
          <HowIGotThis r={r} />
        </s-stack>
      </s-section>
    );

  if (r.kind === "clarify")
    return (
      <s-section heading="Quick question">
        <s-stack gap="base">
          <s-paragraph>{r.text}</s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button onClick={() => onAsk(`${r.question} by revenue`)}>By revenue</s-button>
            <s-button onClick={() => onAsk(`${r.question} by units sold`)}>By units sold</s-button>
          </s-stack>
        </s-stack>
      </s-section>
    );

  const res = r.result!;
  const plan = r.trace.plan?.kind === "query" ? r.trace.plan : null;
  return (
    <s-section heading="Answer">
      <s-stack gap="base">
        <s-paragraph>{r.text}</s-paragraph>
        {plan && plan.assumptions.length > 0 && (
          <s-paragraph>
            <small>Assumptions: {plan.assumptions.join("; ")}</small>
          </s-paragraph>
        )}
        {res.rows.length > 0 && (plan?.groupBy !== "none" || plan?.metric === "list") && (
          <s-table>
            <s-table-header-row>
              {res.columns.map((c, i) => (
                <s-table-header key={c}
                  format={MONEY.has(c) ? "currency" : typeof res.rows[0][i] === "number" ? "numeric" : "base"}>
                  {c}
                </s-table-header>
              ))}
            </s-table-header-row>
            <s-table-body>
              {res.rows.map((row, i) => (
                <s-table-row key={i}>
                  {row.map((v, j) => <s-table-cell key={j}>{fmt(res.columns[j], v)}</s-table-cell>)}
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <HowIGotThis r={r} />
      </s-stack>
    </s-section>
  );
}

// Collapsed by default: the plan, the fixed query used, and the checks.
function HowIGotThis({ r }: { r: Data }) {
  const t = r.trace;
  return (
    <details>
      <summary>How I got this</summary>
      {t.steps.filter((s) => !s.ok).map((s, i) => (
        <s-paragraph key={i}><b>{s.step} failed</b> ({((s.llmAttempts as any[]) ?? []).map((a) => a.model).join(" → ") || "no model"}): {String(s.error ?? s.rejectedReason ?? "")}</s-paragraph>
      ))}
      <s-stack gap="base">
        <s-paragraph>
          Query template: <b>{t.template ?? "none (no data fetched)"}</b> · Pages fetched: {t.pages ?? 0} ·
          Query cost: {t.queryCost ?? 0} · Time: {(t.ms / 1000).toFixed(1)}s
        </s-paragraph>
        <s-paragraph>
          Number check: <b>{t.numberCheck ?? "n/a"}</b>
          {t.usedFallback ? " (model reply rejected, so this sentence was built from the table)" : ""}
          {" · "}Models: {t.models.join(", ") || "none"}
        </s-paragraph>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>
          {JSON.stringify({ plan: t.plan, variables: t.variables }, null, 2)}
        </pre>
      </s-stack>
    </details>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
