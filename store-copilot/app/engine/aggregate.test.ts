import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, localDate, weekStart, UnsupportedPlan } from "./aggregate";
import type { QueryPlan } from "./plan";

const TZ = "America/New_York";
const plan = (p: Partial<QueryPlan>): QueryPlan => ({
  kind: "query", entity: "orders", metric: "sum_revenue", groupBy: "none", dateFrom: null, dateTo: null,
  filter: { productTitleContains: null, productType: null, inventoryBelow: null },
  sort: "desc", limit: 10, assumptions: [], ...p,
} as QueryPlan);
const line = (title: string, type: string, quantity: number, amount: string) =>
  ({ quantity, title, product: { id: title, title, productType: type }, originalTotalSet: { shopMoney: { amount } } });
const order = (id: string, processedAt: string, total: string, lines: any[]) =>
  ({ id, name: id, processedAt, totalPriceSet: { shopMoney: { amount: total } }, lineItems: { nodes: lines } });

const orders = [
  order("o1", "2026-10-01T15:00:00Z", "30.00", [line("Mug", "Drinkware", 2, "20.00"), line("Tee", "Apparel", 1, "10.00")]),
  order("o2", "2026-10-02T03:30:00Z", "10.10", [line("Tee", "Apparel", 1, "10.10")]), // Oct 1, 11:30pm New York
  order("o3", "2026-10-05T15:00:00Z", "0.20", [line("Sticker", "Stationery", 3, "0.20")]),
];
const products = [
  { id: "p1", title: "Mug", productType: "Drinkware", totalInventory: 4, variants: { nodes: [{ price: "10.00" }] } },
  { id: "p2", title: "Tee", productType: "Apparel", totalInventory: 50, variants: { nodes: [{ price: "10.05" }] } },
  { id: "p3", title: "Cap", productType: "Apparel", totalInventory: 0, variants: { nodes: [{ price: "15.00" }] } },
];

test("localDate uses store timezone", () => assert.equal(localDate("2026-10-02T03:30:00Z", TZ), "2026-10-01"));
test("weekStart is Monday", () => {
  assert.equal(weekStart("2026-10-01"), "2026-09-28");
  assert.equal(weekStart("2026-10-05"), "2026-10-05");
});
test("revenue for one local day, no float drift", () =>
  assert.deepEqual(aggregate(plan({ dateFrom: "2026-10-01", dateTo: "2026-10-01" }), orders, TZ).rows, [["all", 40.1]]));
test("total revenue all time", () => assert.deepEqual(aggregate(plan({}), orders, TZ).rows, [["all", 40.3]]));
test("count orders", () => assert.deepEqual(aggregate(plan({ metric: "count_orders" }), orders, TZ).rows, [["all", 3]]));
test("average order value", () =>
  assert.deepEqual(aggregate(plan({ metric: "avg_order_value" }), orders, TZ).rows, [["all", 13.43]]));
test("empty range gives zero, not an empty table", () =>
  assert.deepEqual(aggregate(plan({ dateFrom: "2026-11-01", dateTo: "2026-11-02" }), orders, TZ).rows, [["all", 0]]));
test("top products by revenue", () =>
  assert.deepEqual(aggregate(plan({ groupBy: "product", limit: 2 }), orders, TZ).rows, [["Tee", 20.1], ["Mug", 20]]));
test("top products by units, ties broken by name", () =>
  assert.deepEqual(aggregate(plan({ groupBy: "product", metric: "sum_units", limit: 2 }), orders, TZ).rows,
    [["Sticker", 3], ["Mug", 2]]));
test("product type filter uses line revenue", () =>
  assert.deepEqual(aggregate(plan({ filter: { productTitleContains: null, productType: "apparel", inventoryBelow: null } }),
    orders, TZ).rows, [["all", 20.1]]));
test("daily trend fills empty days", () =>
  assert.deepEqual(aggregate(plan({ metric: "count_orders", groupBy: "day", dateFrom: "2026-10-01", dateTo: "2026-10-03" }),
    orders, TZ).rows, [["2026-10-01", 2], ["2026-10-02", 0], ["2026-10-03", 0]]));
test("weekly trend", () =>
  assert.deepEqual(aggregate(plan({ metric: "count_orders", groupBy: "week", dateFrom: "2026-09-28", dateTo: "2026-10-11" }),
    orders, TZ).rows, [["2026-09-28", 2], ["2026-10-05", 1]]));
test("low stock list, lowest first", () =>
  assert.deepEqual(aggregate(plan({ entity: "inventory", metric: "list", sort: "asc",
    filter: { productTitleContains: null, productType: null, inventoryBelow: 10 } }), products, TZ).rows,
    [["Cap", "Apparel", 0, 15], ["Mug", "Drinkware", 4, 10]]));
test("list on orders is unsupported", () =>
  assert.throws(() => aggregate(plan({ metric: "list" }), orders, TZ), UnsupportedPlan));
