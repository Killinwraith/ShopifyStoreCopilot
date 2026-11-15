import { readFileSync } from "node:fs";

const seed = JSON.parse(readFileSync("scripts/seed.json", "utf8"));
const P: Record<string, any> = Object.fromEntries(seed.products.map((p: any) => [p.key, p]));

// All seed times are 14:00–22:00 UTC, which is the same calendar day in New York.
const day = (o: any): string => o.processedAt.slice(0, 10);
const ordersIn = (from: string, to: string) => seed.orders.filter((o: any) => day(o) >= from && day(o) <= to);
const lineCents = (l: any) => Math.round(l.quantity * Number(P[l.product].price) * 100);

function nextDay(d: string) {
  const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10);
}
function monday(d: string) {
  const x = new Date(d + "T00:00:00Z");
  while (x.getUTCDay() !== 1) x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10);
}
function rank(totals: Record<string, number>, limit: number) {
  return Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map((e) => e[0]);
}

type R = { from: string; to: string };
export const truth = {
  revenue({ from, to }: R) {
    let c = 0;
    for (const o of ordersIn(from, to)) for (const l of o.lines) c += lineCents(l);
    return c / 100;
  },
  orderCount({ from, to }: R) { return ordersIn(from, to).length; },
  units({ from, to, titleContains }: R & { titleContains?: string }) {
    let u = 0;
    for (const o of ordersIn(from, to)) for (const l of o.lines)
      if (!titleContains || P[l.product].title.toLowerCase().includes(titleContains)) u += l.quantity;
    return u;
  },
  aov({ from, to }: R) {
    const os = ordersIn(from, to);
    let c = 0;
    for (const o of os) for (const l of o.lines) c += lineCents(l);
    return os.length ? Math.round(c / os.length) / 100 : 0;
  },
  topProducts({ from, to, by, limit }: R & { by: "revenue" | "units"; limit: number }) {
    const t: Record<string, number> = {};
    for (const o of ordersIn(from, to)) for (const l of o.lines) {
      const k = P[l.product].title;
      t[k] = (t[k] ?? 0) + (by === "units" ? l.quantity : lineCents(l));
    }
    return rank(t, limit);
  },
  topTypes({ from, to, by, limit }: R & { by: "revenue" | "units"; limit: number }) {
    const t: Record<string, number> = {};
    for (const o of ordersIn(from, to)) for (const l of o.lines) {
      const k = P[l.product].productType;
      t[k] = (t[k] ?? 0) + (by === "units" ? l.quantity : lineCents(l));
    }
    return rank(t, limit);
  },
  trend({ from, to, bucket, metric }: R & { bucket: "day" | "week"; metric: "count" | "revenue" }) {
    const t = new Map<string, number>();
    for (let d = from; d <= to; d = nextDay(d)) t.set(bucket === "day" ? d : monday(d), 0);
    for (const o of ordersIn(from, to)) {
      const k = bucket === "day" ? day(o) : monday(day(o));
      t.set(k, t.get(k)! + (metric === "count" ? 1 : o.lines.reduce((s: number, l: any) => s + lineCents(l), 0)));
    }
    return [...t].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, metric === "revenue" ? v / 100 : v]);
  },
  lowStock({ below }: { below: number }) {
    return seed.products.filter((p: any) => p.stock < below).map((p: any) => p.title);
  },
};
