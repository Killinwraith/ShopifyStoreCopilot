import { z } from "zod";

// This is the contract: the model may only output something that fits this shape. Everything after it is plain code.

export const Plan = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("query"),
    entity: z.enum(["orders", "products", "inventory"]),
    metric: z.enum(["sum_revenue", "count_orders", "sum_units", "avg_order_value", "list"]),
    groupBy: z.enum(["none", "product", "product_type", "day", "week"]),
    dateFrom: z.string().date().nullable(), // inclusive, store timezone
    dateTo: z.string().date().nullable(),   // inclusive
    filter: z.object({
      productTitleContains: z.string().nullable(),
      productType: z.string().nullable(),
      inventoryBelow: z.number().int().nullable(),
    }),
    sort: z.enum(["desc", "asc"]),
    limit: z.number().int().min(1).max(50),
    assumptions: z.array(z.string()),
  }),
  z.object({ kind: z.literal("refuse"),
    reason: z.enum(["write_action", "customer_pii", "off_topic", "unsupported"]) }),
  z.object({ kind: z.literal("clarify"), question: z.string() }),
]);

export type Plan = z.infer<typeof Plan>;
export type QueryPlan = Extract<Plan, { kind: "query" }>;
