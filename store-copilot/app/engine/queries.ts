import type { QueryPlan } from "./plan";

// Fixed templates. The plan only ever fills variables.
export const TEMPLATES = {
  shop: `query Shop { shop { ianaTimezone currencyCode } }`,
  orders: `query Orders($q: String!, $after: String) {
  orders(first: 50, after: $after, query: $q, sortKey: PROCESSED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name processedAt
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 10) { nodes { quantity title product { id title productType }
        originalTotalSet { shopMoney { amount } } } }
    }
  }
}`,
  products: `query Products($q: String!, $after: String) {
  products(first: 100, after: $after, query: $q, sortKey: TITLE) {
    pageInfo { hasNextPage endCursor }
    nodes { id title productType totalInventory variants(first: 1) { nodes { price } } }
  }
}`,
} as const;

export type TemplateName = keyof typeof TEMPLATES;
export type PagedTemplate = Exclude<TemplateName, "shop">;

const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

// Only zod-validated dates go into the search string. Title and type filters run in code.
export function toRequest(plan: QueryPlan): { template: PagedTemplate; q: string } {
  if (plan.entity !== "orders") return { template: "products", q: "" };
  const parts: string[] = [];
  if (plan.dateFrom) parts.push(`processed_at:>=${addDays(plan.dateFrom, -1)}`); // pad 1 day each side;
  if (plan.dateTo) parts.push(`processed_at:<=${addDays(plan.dateTo, 1)}`);     // aggregate.ts filters exact local dates
  return { template: "orders", q: parts.join(" ") };
}
