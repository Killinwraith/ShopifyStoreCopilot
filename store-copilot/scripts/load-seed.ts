import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const API = "2026-07";
const seed = JSON.parse(readFileSync("scripts/seed.json", "utf8"));
const PROG = "scripts/seed-progress.json";
const prog = existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf8")) : { variants: {}, orders: {} };
const save = () => writeFileSync(PROG, JSON.stringify(prog, null, 2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sess = await new PrismaClient().session.findFirst({ where: { isOnline: false } });
if (!sess) throw new Error("No offline session: open the app in the admin first");

async function gql(query: string, variables: object = {}) {
  const res = await fetch(`https://${sess!.shop}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": sess!.accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (!res.ok || j.errors) throw new Error(`${res.status} ${JSON.stringify(j.errors ?? j)}`);
  const payload: any = Object.values(j.data)[0];
  if (payload?.userErrors?.length) throw new Error(JSON.stringify(payload.userErrors));
  return payload;
}

const loc = (await gql(`{ locations(first:1){ nodes{ id } } }`)).nodes[0].id;

for (const p of seed.products) {
  if (prog.variants[p.key]) continue;
  const d = await gql(`mutation($input: ProductSetInput!){ productSet(synchronous:true, input:$input){
      product{ variants(first:1){ nodes{ id } } } userErrors{ field message } } }`, { input: {
    title: p.title, productType: p.productType, status: "ACTIVE",
    productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
    variants: [{ optionValues: [{ optionName: "Title", name: "Default Title" }], price: p.price,
      inventoryItem: { tracked: true },
      inventoryQuantities: [{ locationId: loc, name: "available", quantity: p.stock }] }],
  } });
  prog.variants[p.key] = d.product.variants.nodes[0].id; save(); console.log("product", p.key);
}

for (const o of seed.orders) {
  if (prog.orders[o.key]) continue;
  const d = await gql(`mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput){
      orderCreate(order:$order, options:$options){ order{ id name } userErrors{ field message } } }`, {
    order: { processedAt: o.processedAt, test: true, financialStatus: "PAID",
      lineItems: o.lines.map((l: any) => ({ variantId: prog.variants[l.product], quantity: l.quantity })) },
    options: { inventoryBehaviour: "BYPASS", sendReceipt: false, sendFulfillmentReceipt: false },
  });
  prog.orders[o.key] = d.order.name; save();
  console.log(o.key, d.order.name, `${Object.keys(prog.orders).length}/${seed.orders.length}`);
  await sleep(13000); // dev store limit: 5 orders per minute
}
console.log("done");
