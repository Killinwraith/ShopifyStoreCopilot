import type { QueryPlan } from "./plan";

export type Cell = string | number;
export type Result = { columns: string[]; rows: Cell[][] };
export class UnsupportedPlan extends Error {}

type Line = { quantity: number; title: string;
  product: { id: string; title: string; productType: string } | null;
  originalTotalSet: { shopMoney: { amount: string } } };
type Order = { id: string; name: string; processedAt: string;
  totalPriceSet: { shopMoney: { amount: string } }; lineItems: { nodes: Line[] } };
type Product = { id: string; title: string; productType: string; totalInventory: number;
  variants: { nodes: { price: string }[] } };

// Money is summed in integer cents, so there's no 0.1 + 0.2 drift.
const cents = (s: string) => Math.round(parseFloat(s) * 100);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

export function localDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(iso));
}

// Monday of the week containing a YYYY-MM-DD date
export function weekStart(d: string): string {
  const dow = (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7;
  return addDays(d, -dow);
}

const GROUP_LABEL = { none: "all", product: "product", product_type: "product type", day: "day", week: "week starting" };
const METRIC_LABEL = { sum_revenue: "revenue", count_orders: "orders", sum_units: "units",
  avg_order_value: "average order value", list: "list" };

const has = (s: string, sub: string | null) => !sub || s.toLowerCase().includes(sub.toLowerCase());
const eq = (s: string, t: string | null) => !t || s.toLowerCase() === t.toLowerCase();

export function aggregate(plan: QueryPlan, rows: any[], tz: string): Result {
  return plan.entity === "orders" ? aggregateOrders(plan, rows, tz) : aggregateProducts(plan, rows);
}

function aggregateOrders(plan: QueryPlan, orders: Order[], tz: string): Result {
  const f = plan.filter;
  const lineLevel = !!(f.productTitleContains || f.productType)
    || plan.groupBy === "product" || plan.groupBy === "product_type";

  type B = { orders: Set<string>; cents: number; units: number };
  const buckets = new Map<string, B>();
  const add = (k: string, id: string, c: number, u: number) => {
    const b = buckets.get(k) ?? { orders: new Set<string>(), cents: 0, units: 0 };
    b.orders.add(id); b.cents += c; b.units += u; buckets.set(k, b);
  };

  for (const o of orders) {
    const date = localDate(o.processedAt, tz);
    if ((plan.dateFrom && date < plan.dateFrom) || (plan.dateTo && date > plan.dateTo)) continue;
    const lines = o.lineItems.nodes.filter((l) =>
      has(l.product?.title ?? l.title, f.productTitleContains) && eq(l.product?.productType ?? "", f.productType));
    if (!lines.length) continue;

    if (plan.groupBy === "product" || plan.groupBy === "product_type") {
      for (const l of lines) {
        const k = plan.groupBy === "product" ? (l.product?.title ?? l.title) : (l.product?.productType || "(none)");
        add(k, o.id, cents(l.originalTotalSet.shopMoney.amount), l.quantity);
      }
    } else {
      const k = plan.groupBy === "day" ? date : plan.groupBy === "week" ? weekStart(date) : "all";
      const c = lineLevel
        ? lines.reduce((s, l) => s + cents(l.originalTotalSet.shopMoney.amount), 0)
        : cents(o.totalPriceSet.shopMoney.amount);
      add(k, o.id, c, lines.reduce((s, l) => s + l.quantity, 0));
    }
  }

  // Trends show empty days and weeks as 0 instead of skipping them.
  const empty = (): B => ({ orders: new Set(), cents: 0, units: 0 });
  if ((plan.groupBy === "day" || plan.groupBy === "week") && plan.dateFrom && plan.dateTo)
    for (let d = plan.dateFrom; d <= plan.dateTo; d = addDays(d, 1)) {
      const k = plan.groupBy === "day" ? d : weekStart(d);
      if (!buckets.has(k)) buckets.set(k, empty());
    }
  if (plan.groupBy === "none" && !buckets.has("all")) buckets.set("all", empty());

  const value = (b: B): number => {
    switch (plan.metric) {
      case "sum_revenue": return b.cents / 100;
      case "count_orders": return b.orders.size;
      case "sum_units": return b.units;
      case "avg_order_value": return b.orders.size ? Math.round(b.cents / b.orders.size) / 100 : 0;
      case "list": throw new UnsupportedPlan("'list' only works for products and inventory");
    }
  };

  let out: [string, number][] = [...buckets].map(([k, b]) => [k, value(b)]);
  if (plan.groupBy === "day" || plan.groupBy === "week") out.sort((a, b) => a[0].localeCompare(b[0]));
  else {
    const dir = plan.sort === "asc" ? 1 : -1;
    out.sort((a, b) => dir * (a[1] - b[1]) || a[0].localeCompare(b[0])); // ties broken by name, so output is stable
    out = out.slice(0, plan.limit);
  }
  return { columns: [GROUP_LABEL[plan.groupBy], METRIC_LABEL[plan.metric]], rows: out };
}

function aggregateProducts(plan: QueryPlan, products: Product[]): Result {
  const f = plan.filter;
  const ps = products.filter((p) => has(p.title, f.productTitleContains) && eq(p.productType, f.productType)
    && (f.inventoryBelow == null || p.totalInventory < f.inventoryBelow));

  if (plan.metric === "sum_units") { // total units in stock
    const m = new Map<string, number>();
    for (const p of ps) {
      const k = plan.groupBy === "product_type" ? p.productType : "all";
      m.set(k, (m.get(k) ?? 0) + p.totalInventory);
    }
    if (!m.size) m.set("all", 0);
    return { columns: [GROUP_LABEL[plan.groupBy], "units in stock"], rows: [...m].sort((a, b) => a[0].localeCompare(b[0])) };
  }
  if (plan.metric !== "list") throw new UnsupportedPlan(`'${plan.metric}' doesn't apply to ${plan.entity}`);

  const dir = plan.sort === "asc" ? 1 : -1;
  const rows = [...ps]
    .sort((a, b) => dir * (a.totalInventory - b.totalInventory) || a.title.localeCompare(b.title))
    .slice(0, plan.limit)
    .map((p) => [p.title, p.productType, p.totalInventory, Number(p.variants.nodes[0]?.price ?? 0)]);
  return { columns: ["product", "type", "in stock", "price"], rows };
}
