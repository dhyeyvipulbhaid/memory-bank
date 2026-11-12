import { afterEach, expect, test } from "bun:test";
import { createFakeExtractor, estimateTokens, openBank } from "../src/index.ts";
import { readRows, tempDbPath } from "./helpers.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function dbPath(): string {
  const created = tempDbPath();
  cleanups.push(created.cleanup);
  return created.path;
}

test("recall returns facts that match the query and skips the rest of the bank", async () => {
  const path = dbPath();
  const bank = openBank(path);
  await bank.remember({
    text: "The lighthouse keeper keeps a spare key under the mat.",
    entities: [{ name: "Lighthouse", type: "place" }],
    mentionedAt: "2024-03-01T00:00:00.000Z",
  });
  await bank.remember({
    text: "Maya paints in the studio on Sundays.",
    entities: [{ name: "Maya", type: "person" }],
    mentionedAt: "2024-03-02T00:00:00.000Z",
  });

  const result = await bank.recall({ query: "lighthouse key", tokenBudget: 200 });
  expect(result.facts.map((fact) => fact.text)).toEqual([
    "The lighthouse keeper keeps a spare key under the mat.",
  ]);
  expect(result.tokensUsed).toBeLessThanOrEqual(200);
  expect(result.tokensUsed).toBe(estimateTokens(result.facts[0]?.text ?? ""));
  bank.close();
});

test("recall respects tokenBudget and does not dump a long source", async () => {
  const path = dbPath();
  const shortText = "Lighthouse key is under the mat.";
  const longText = `Lighthouse key log. ${"lighthouse key detail ".repeat(80)}`;
  const source = `Field notes.\n\n${"Unrelated observation about the docks. ".repeat(200)}`;
  const bank = openBank(path, {
    extractor: createFakeExtractor(() => [
      {
        text: shortText,
        kind: "world",
        occurrenceTime: null,
        entities: [{ name: "Lighthouse", type: "place" }],
      },
    ]),
  });

  await bank.remember({
    text: longText,
    entities: [{ name: "Lighthouse", type: "place" }],
    mentionedAt: "2024-04-05T00:00:00.000Z",
  });
  await bank.retain({
    content: source,
    mentionedAt: "2024-04-03T00:00:00.000Z",
  });

  const budget = estimateTokens(shortText);
  const result = await bank.recall({ query: "lighthouse key", tokenBudget: budget });
  expect(result.facts.map((fact) => fact.text)).toEqual([shortText]);
  expect(result.tokensUsed).toBeLessThanOrEqual(budget);
  expect(result.facts.every((fact) => fact.text.length < source.length)).toBe(true);

  const stored = readRows<{ text: string }>(path, "SELECT text FROM sources WHERE text LIKE 'Field notes.%'");
  expect(stored[0]?.text).toBe(source);
  const chunks = readRows<{ text: string }>(
    path,
    "SELECT source_chunks.text AS text FROM source_chunks JOIN sources ON sources.id = source_chunks.source_id WHERE sources.text LIKE 'Field notes.%' ORDER BY ordinal",
  );
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) expect(source.includes(chunk.text)).toBe(true);
  bank.close();
});

test("an empty query does not dump the bank", async () => {
  const path = dbPath();
  const bank = openBank(path);
  await bank.remember({
    text: "The archive holds the city maps.",
    entities: [{ name: "Archive", type: "place" }],
  });
  const result = await bank.recall({ query: "   ", tokenBudget: 5000 });
  expect(result).toEqual({ facts: [], tokensUsed: 0 });
  bank.close();
});

test("a zero token budget returns no facts", async () => {
  const path = dbPath();
  const bank = openBank(path);
  await bank.remember({
    text: "Nia keeps a red notebook.",
    entities: [{ name: "Nia", type: "person" }],
  });
  const result = await bank.recall({ query: "Nia notebook", tokenBudget: 0 });
  expect(result.facts).toEqual([]);
  expect(result.tokensUsed).toBe(0);
  bank.close();
});

test("recall in one bank cannot see another bank", async () => {
  const path = dbPath();
  const alpha = openBank(path, { bankId: "alpha" });
  const beta = openBank(path, { bankId: "beta" });
  await alpha.remember({
    text: "Alpha stores the coral lantern passphrase.",
    entities: [{ name: "Coral Lantern", type: "concept" }],
  });
  await beta.remember({
    text: "Beta stores the bakery hours.",
    entities: [{ name: "Bakery", type: "place" }],
  });

  const fromBeta = await beta.recall({ query: "coral lantern passphrase", tokenBudget: 400 });
  expect(fromBeta.facts).toEqual([]);
  const fromAlpha = await alpha.recall({ query: "coral lantern", tokenBudget: 400 });
  expect(fromAlpha.facts).toHaveLength(1);
  expect(fromAlpha.facts[0]?.text).toContain("coral lantern");
  alpha.close();
  beta.close();
});

test("an alias finds facts saved under the fuller name", async () => {
  const path = dbPath();
  const bank = openBank(path);
  await bank.remember({
    text: "Alice Chen moved the review to Monday.",
    entities: [{ name: "Alice Chen", type: "person" }],
  });
  await bank.remember({
    text: "Alice sent the revised agenda.",
    entities: [{ name: "Alice", type: "person" }],
  });
  const result = await bank.recall({ query: "Alice agenda", tokenBudget: 300 });
  expect(result.facts.map((fact) => fact.text)).toContain("Alice sent the revised agenda.");
  expect(result.facts.every((fact) => fact.entities.some((entity) => entity.name === "Alice Chen"))).toBe(
    true,
  );
  bank.close();
});
