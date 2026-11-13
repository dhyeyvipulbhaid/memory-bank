import { afterEach, expect, test } from "bun:test";
import {
  EmbedderUnavailableError,
  createFakeEmbedder,
  estimateTokens,
  openBank,
  type Reranker,
} from "../src/index.ts";
import { tempDbPath } from "./helpers.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function dbPath(): string {
  const created = tempDbPath();
  cleanups.push(created.cleanup);
  return created.path;
}

const NOW = "2026-11-13T12:00:00.000Z";
const KEYWORD_ONLY = "A beacon marked the northwind ridge.";
const VECTOR_ONLY = "Crates sat in the warehouse.";
const GRAPH_ONLY = "The team signed the lease.";
const MULTI = "Northwind shifted crates.";
const QUERY = "northwind beacon";

function scripted(map: Record<string, readonly number[]>) {
  return createFakeEmbedder((text) => {
    const vector = map[text];
    if (!vector) throw new Error(`no vector scripted for: ${text}`);
    return vector;
  });
}

async function fusionBank(path: string) {
  const bank = openBank(path, {
    embedder: scripted({
      [KEYWORD_ONLY]: [0, 1, 0],
      [VECTOR_ONLY]: [1, 0, 0],
      [GRAPH_ONLY]: [0, 0, 1],
      [MULTI]: [0.8, 0.2, 0],
      [QUERY]: [1, 0, 0],
    }),
  });
  await bank.remember({
    text: GRAPH_ONLY,
    mentionedAt: NOW,
    entities: [
      { name: "Northwind", type: "org" },
      { name: "Beacon", type: "product" },
    ],
  });
  await bank.remember({
    text: KEYWORD_ONLY,
    mentionedAt: NOW,
  });
  await bank.remember({
    text: VECTOR_ONLY,
    mentionedAt: NOW,
  });
  await bank.remember({
    text: MULTI,
    mentionedAt: NOW,
    entities: [{ name: "Northwind", type: "org" }],
  });
  return bank;
}

test("fusion ranks a fact that is only second on every list ahead of each single-signal winner", async () => {
  const bank = await fusionBank(dbPath());
  const result = await bank.hybridRecall({ query: QUERY, tokenBudget: 500, now: NOW });
  expect(result.facts[0]?.text).toBe(MULTI);
  const winner = result.facts[0];
  expect(winner?.breakdown.keyword).toBeGreaterThan(0);
  expect(winner?.breakdown.vector).toBeGreaterThan(0);
  expect(winner?.breakdown.graph).toBeGreaterThan(0);
  expect(winner?.breakdown.recency).toBe(1);
  expect(winner?.score).toBeCloseTo(
    (winner?.breakdown.keyword ?? 0) + (winner?.breakdown.vector ?? 0) + (winner?.breakdown.graph ?? 0),
  );

  const byText = new Map(result.facts.map((fact) => [fact.text, fact]));
  expect(winner?.score).toBeGreaterThan(byText.get(KEYWORD_ONLY)?.score ?? 0);
  expect(winner?.score).toBeGreaterThan(byText.get(VECTOR_ONLY)?.score ?? 0);
  expect(winner?.score).toBeGreaterThan(byText.get(GRAPH_ONLY)?.score ?? 0);
  expect(byText.get(KEYWORD_ONLY)?.breakdown.vector).toBe(0);
  expect(byText.get(KEYWORD_ONLY)?.breakdown.graph).toBe(0);
  expect(byText.get(VECTOR_ONLY)?.breakdown.keyword).toBe(0);
  expect(byText.get(GRAPH_ONLY)?.breakdown.keyword).toBe(0);
  bank.close();
});

test("raising the vector weight selects the vector winner", async () => {
  const bank = await fusionBank(dbPath());
  const result = await bank.hybridRecall({
    query: QUERY,
    tokenBudget: 500,
    now: NOW,
    weights: { keyword: 0, vector: 1, graph: 0 },
  });
  expect(result.facts[0]?.text).toBe(VECTOR_ONLY);
  bank.close();
});

test("a one-hop neighbor is returned and keyword recall does not see it", async () => {
  const bank = openBank(dbPath());
  await bank.remember({
    text: "Maya joined the studio.",
    mentionedAt: NOW,
    entities: [
      { name: "Maya", type: "person" },
      { name: "Studio", type: "place" },
    ],
  });
  await bank.remember({
    text: "The lease renewed in spring.",
    mentionedAt: NOW,
    entities: [{ name: "Studio", type: "place" }],
  });

  const keyword = await bank.recall({ query: "Maya", tokenBudget: 200 });
  expect(keyword.facts.map((fact) => fact.text)).toEqual(["Maya joined the studio."]);

  const hybrid = await bank.hybridRecall({ query: "Maya", tokenBudget: 200, now: NOW });
  expect(hybrid.facts.map((fact) => fact.text)).toContain("The lease renewed in spring.");
  const neighbor = hybrid.facts.find((fact) => fact.text === "The lease renewed in spring.");
  expect(neighbor?.breakdown.graph).toBeGreaterThan(0);
  expect(neighbor?.breakdown.keyword).toBe(0);
  expect(hybrid.facts[0]?.text).toBe("Maya joined the studio.");
  bank.close();
});

test("an alias match finds a fact whose text does not contain the alias", async () => {
  const bank = openBank(dbPath());
  await bank.remember({
    text: "Alice Chen keeps the checklist.",
    mentionedAt: NOW,
    entities: [{ name: "Alice Chen", type: "person" }],
  });
  await bank.remember({
    text: "Notes were filed.",
    mentionedAt: NOW,
    entities: [{ name: "Alice", type: "person" }],
  });

  const result = await bank.hybridRecall({ query: "Alice", tokenBudget: 200, now: NOW });
  const notes = result.facts.find((fact) => fact.text === "Notes were filed.");
  expect(notes?.breakdown.graph).toBeGreaterThan(0);
  expect(notes?.breakdown.keyword).toBe(0);
  bank.close();
});

test("a newer fact outranks an older one when the other signals tie", async () => {
  const bank = openBank(dbPath());
  await bank.remember({ text: "Beacon glowed.", mentionedAt: "2026-09-14T12:00:00.000Z" });
  await bank.remember({ text: "Beacon flashed.", mentionedAt: NOW });

  const result = await bank.hybridRecall({
    query: "beacon",
    tokenBudget: 200,
    now: NOW,
    halfLifeDays: 30,
  });
  expect(result.facts.map((fact) => fact.text)[0]).toBe("Beacon flashed.");
  expect(result.facts[0]?.breakdown.recency).toBeGreaterThan(result.facts[1]?.breakdown.recency ?? 0);
  bank.close();
});

test("what did I do last week stays inside that week", async () => {
  const bank = openBank(dbPath());
  await bank.remember({ text: "I shipped the patch.", mentionedAt: "2026-11-04T15:00:00.000Z" });
  await bank.remember({ text: "I watered the plants.", mentionedAt: "2026-11-12T15:00:00.000Z" });
  await bank.remember({ text: "I closed the books.", mentionedAt: "2026-10-01T12:00:00.000Z" });

  const result = await bank.hybridRecall({
    query: "what did I do last week",
    tokenBudget: 200,
    now: NOW,
  });
  expect(result.facts.map((fact) => fact.text)).toEqual(["I shipped the patch."]);
  bank.close();
});

test("hybrid recall skips a fact that does not fit the token budget", async () => {
  const bank = openBank(dbPath());
  const shortText = "Beacon noted.";
  const longText = `Beacon report. ${"detail ".repeat(40)}`;
  await bank.remember({ text: longText, mentionedAt: NOW });
  await bank.remember({ text: shortText, mentionedAt: NOW });
  const budget = estimateTokens(shortText);
  expect(estimateTokens(longText)).toBeGreaterThan(budget);

  const result = await bank.hybridRecall({ query: "beacon", tokenBudget: budget, now: NOW });
  expect(result.facts.map((fact) => fact.text)).toEqual([shortText]);
  expect(result.tokensUsed).toBeLessThanOrEqual(budget);
  bank.close();
});

test("a down embedder leaves keyword and graph recall working", async () => {
  const bank = openBank(dbPath(), {
    embedder: createFakeEmbedder(() => {
      throw new EmbedderUnavailableError("Ollama is not reachable");
    }),
  });
  await bank.remember({
    text: "Maya prefers morning meetings.",
    mentionedAt: NOW,
    entities: [{ name: "Maya", type: "person" }],
  });

  const result = await bank.hybridRecall({ query: "Maya meetings", tokenBudget: 200, now: NOW });
  expect(result.facts.map((fact) => fact.text)).toEqual(["Maya prefers morning meetings."]);
  expect(result.facts[0]?.breakdown.vector).toBe(0);
  expect(result.facts[0]?.breakdown.keyword).toBeGreaterThan(0);
  expect(result.facts[0]?.breakdown.graph).toBeGreaterThan(0);

  const keyword = await bank.recall({ query: "Maya meetings", tokenBudget: 200 });
  expect(keyword.facts.map((fact) => fact.text)).toEqual(["Maya prefers morning meetings."]);
  bank.close();
});

test("llm rerank is off unless asked, and a failed rerank keeps fusion order", async () => {
  const path = dbPath();
  let calls = 0;
  const reranker: Reranker = {
    async rerank(input) {
      calls += 1;
      return [...input.facts].reverse().map((fact) => fact.id);
    },
  };
  const bank = openBank(path, { reranker });
  const first = await bank.remember({ text: "Alpha beacon is ready.", mentionedAt: NOW });
  const second = await bank.remember({ text: "Beacon only.", mentionedAt: NOW });

  const fused = await bank.hybridRecall({ query: "alpha beacon", tokenBudget: 200, now: NOW });
  expect(calls).toBe(0);
  expect(fused.facts.map((fact) => fact.text)).toEqual(["Alpha beacon is ready.", "Beacon only."]);

  const reranked = await bank.hybridRecall({
    query: "alpha beacon",
    tokenBudget: 200,
    now: NOW,
    llmRerank: true,
  });
  expect(calls).toBe(1);
  expect(reranked.facts.map((fact) => fact.id)).toEqual([second.id, first.id]);

  bank.close();
  const failing = openBank(path, {
    reranker: {
      rerank() {
        throw new Error("rerank down");
      },
    },
  });
  const kept = await failing.hybridRecall({
    query: "alpha beacon",
    tokenBudget: 200,
    now: NOW,
    llmRerank: true,
  });
  expect(kept.facts.map((fact) => fact.text)).toEqual(["Alpha beacon is ready.", "Beacon only."]);
  failing.close();
});
