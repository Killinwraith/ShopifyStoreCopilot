import { mkdirSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { ShopifyDataSource } from "../app/engine/fetch.server";
import { TEMPLATES } from "../app/engine/queries";

const sess = await new PrismaClient().session.findFirst({ where: { isOnline: false } });
if (!sess) throw new Error("No offline session: open the app in the admin first");

const post = async (query: string, variables: object) =>
  (await fetch(`https://${sess.shop}/admin/api/2026-07/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": sess.accessToken },
    body: JSON.stringify({ query, variables }),
  })).json();

const ds = new ShopifyDataSource(post);
const save = (n: string, d: unknown) => writeFileSync(`evals/fixtures/${n}.json`, JSON.stringify(d, null, 2));
mkdirSync("evals/fixtures", { recursive: true });

save("shop", (await post(TEMPLATES.shop, {})).data.shop);
for (const t of ["orders", "products"] as const) {
  const r = await ds.fetchAll(t, "");
  save(t, r.rows);
  console.log(t, r.rows.length, "rows,", r.pages, "pages, cost", r.cost);
}
