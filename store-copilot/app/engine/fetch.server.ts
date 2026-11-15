import { parse, Kind } from "graphql";
import { readFileSync } from "node:fs";
import { TEMPLATES, type PagedTemplate } from "./queries";

export type Post = (query: string, variables: Record<string, unknown>) => Promise<any>; // raw { data, errors, extensions }
export type FetchResult = {
  template: PagedTemplate; variables: { q: string };
  rows: any[]; pages: number; cost: number; capped: boolean; ms: number;
};
export interface DataSource {
  timezone(): Promise<string>;
  fetchAll(template: PagedTemplate, q: string): Promise<FetchResult>;
}

const MAX_PAGES = 20;

// Guardrail layer 4: only `query` operations ever reach the API.
export function assertReadOnly(doc: string) {
  for (const def of parse(doc).definitions)
    if (def.kind !== Kind.OPERATION_DEFINITION || def.operation !== "query")
      throw new Error("Blocked: non-query GraphQL operation");
}

export class ShopifyDataSource implements DataSource {
  constructor(private post: Post) {}

  private async call(doc: string, variables: Record<string, unknown>) {
    assertReadOnly(doc);
    const j = await this.post(doc, variables);
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j;
  }

  async timezone() {
    return (await this.call(TEMPLATES.shop, {})).data.shop.ianaTimezone as string;
  }

  async fetchAll(template: PagedTemplate, q: string): Promise<FetchResult> {
    const t0 = Date.now();
    const rows: any[] = [];
    let after: string | null = null, pages = 0, cost = 0;
    while (pages < MAX_PAGES) {
      const j = await this.call(TEMPLATES[template], { q, after });
      const conn = j.data[template];
      pages++;
      cost += j.extensions?.cost?.actualQueryCost ?? 0;
      rows.push(...conn.nodes);
      if (!conn.pageInfo.hasNextPage)
        return { template, variables: { q }, rows, pages, cost, capped: false, ms: Date.now() - t0 };
      after = conn.pageInfo.endCursor;
    }
    return { template, variables: { q }, rows, pages, cost, capped: true, ms: Date.now() - t0 };
  }
}

// Evals and CI: same interface, reads saved JSON. Returns every row; aggregate.ts does the filtering.
export class FixtureDataSource implements DataSource {
  constructor(private dir = "evals/fixtures") {}
  private load(name: string) { return JSON.parse(readFileSync(`${this.dir}/${name}.json`, "utf8")); }
  async timezone() { return this.load("shop").ianaTimezone as string; }
  async fetchAll(template: PagedTemplate, q: string): Promise<FetchResult> {
    return { template, variables: { q }, rows: this.load(template), pages: 0, cost: 0, capped: false, ms: 0 };
  }
}
