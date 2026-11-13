import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createFakeExtractor, openBank } from "../src/index.ts";
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

const preference = "Maya prefers morning meetings";

test("retain of the same preference twice stores one fact", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    extractor: createFakeExtractor(() => [
      {
        text: preference,
        kind: "world",
        occurrenceTime: null,
        entities: [{ name: "Maya", type: "person" }],
      },
    ]),
  });

  const first = await bank.retain({
    content: "Maya prefers morning meetings.",
    mentionedAt: "2024-01-01T00:00:00.000Z",
  });
  const second = await bank.retain({
    content: "Maya prefers morning meetings.",
    mentionedAt: "2024-02-01T00:00:00.000Z",
  });

  expect(second.facts).toHaveLength(1);
  expect(second.facts[0]?.id).toBe(first.facts[0]?.id);
  expect(second.facts[0]?.mentionedAt).toBe("2024-01-01T00:00:00.000Z");
  expect(readRows(path, "SELECT id FROM facts")).toHaveLength(1);
  expect(readRows(path, "SELECT id FROM sources")).toHaveLength(2);
  bank.close();
});

test("a later retain that restates an existing fact does not create a second row", async () => {
  const path = dbPath();
  let call = 0;
  const bank = openBank(path, {
    extractor: createFakeExtractor(() => {
      call += 1;
      return [
        {
          text: call === 1 ? preference : "  MAYA   prefers\nmorning meetings ",
          kind: "world",
          occurrenceTime: null,
          entities: [{ name: "Maya", type: "person" }],
        },
      ];
    }),
  });

  const first = await bank.retain({
    content: "You: mornings? Maya: I prefer morning meetings.",
    mentionedAt: "2026-11-12T22:15:00.000Z",
  });
  const second = await bank.retain({
    content: "Recalling the earlier note: Maya prefers morning meetings.",
    mentionedAt: "2026-11-13T10:00:00.000Z",
  });

  expect(second.facts[0]?.id).toBe(first.facts[0]?.id);
  expect(second.facts[0]?.text).toBe(preference);
  expect(second.facts[0]?.mentionedAt).toBe("2026-11-12T22:15:00.000Z");
  expect(second.facts[0]?.sourceId).toBe(first.facts[0]?.sourceId);
  expect(readRows<{ text: string }>(path, "SELECT text FROM facts")).toEqual([
    { text: preference },
  ]);
  const sources = readRows<{ text: string }>(path, "SELECT text FROM sources ORDER BY mentioned_at");
  expect(sources.map((row) => row.text)).toEqual([
    "You: mornings? Maya: I prefer morning meetings.",
    "Recalling the earlier note: Maya prefers morning meetings.",
  ]);

  const recalled = await bank.recall({ query: "Maya morning meetings", tokenBudget: 200 });
  expect(recalled.facts.map((fact) => fact.id)).toEqual([first.facts[0]?.id]);
  bank.close();
});

test("one retain that extracts the same fact twice stores a single row", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    extractor: createFakeExtractor(() => [
      {
        text: preference,
        kind: "world",
        occurrenceTime: null,
        entities: [{ name: "Maya", type: "person" }],
      },
      {
        text: "  maya prefers   morning meetings ",
        kind: "experience",
        occurrenceTime: null,
        entities: [{ name: "Standup", type: "concept" }],
      },
    ]),
  });

  const result = await bank.retain({
    content: "Maya prefers morning meetings, and the standup follows that.",
    mentionedAt: "2024-04-01T00:00:00.000Z",
  });

  expect(result.facts.map((fact) => fact.id)).toEqual([result.facts[0]?.id, result.facts[0]?.id]);
  expect(readRows(path, "SELECT id FROM facts")).toHaveLength(1);
  const names = result.facts[1]?.entities.map((entity) => entity.name).sort();
  expect(names).toEqual(["Maya", "Standup"]);
  bank.close();
});

test("remember of the same text twice stores one fact", async () => {
  const path = dbPath();
  const bank = openBank(path);
  const first = await bank.remember({
    text: preference,
    kind: "world",
    entities: [{ name: "Maya", type: "person" }],
    mentionedAt: "2024-01-01T00:00:00.000Z",
  });
  const second = await bank.remember({
    text: "  maya   prefers\nmorning meetings ",
    kind: "experience",
    entities: [{ name: "Pepper", type: "other" }],
    occurrenceTime: "2024-05-01T00:00:00.000Z",
    mentionedAt: "2024-06-02T00:00:00.000Z",
  });

  expect(second.id).toBe(first.id);
  expect(second.text).toBe(preference);
  expect(second.kind).toBe("world");
  expect(second.mentionedAt).toBe("2024-01-01T00:00:00.000Z");
  expect(second.sourceId).toBe(first.sourceId);
  expect(second.occurrenceTime).toBe("2024-05-01T00:00:00.000Z");
  expect(second.entities.map((entity) => entity.name).sort()).toEqual(["Maya", "Pepper"]);
  expect(readRows(path, "SELECT id FROM facts")).toHaveLength(1);
  expect(readRows(path, "SELECT id FROM sources")).toHaveLength(2);

  const cleared = await bank.remember({
    text: "MAYA prefers morning meetings",
    occurrenceTime: null,
    mentionedAt: "2024-07-01T00:00:00.000Z",
  });
  expect(cleared.id).toBe(first.id);
  expect(cleared.occurrenceTime).toBe("2024-05-01T00:00:00.000Z");
  expect(cleared.mentionedAt).toBe("2024-01-01T00:00:00.000Z");

  const replaced = await bank.remember({
    text: preference,
    occurrenceTime: "2024-08-01T00:00:00.000Z",
  });
  expect(replaced.id).toBe(first.id);
  expect(replaced.occurrenceTime).toBe("2024-05-01T00:00:00.000Z");
  expect(readRows<{ occurrence_time: string | null }>(path, "SELECT occurrence_time FROM facts")).toEqual([
    { occurrence_time: "2024-05-01T00:00:00.000Z" },
  ]);
  bank.close();
});

test("different facts stay distinct", async () => {
  const path = dbPath();
  const bank = openBank(path);
  await bank.remember({
    text: preference,
    entities: [{ name: "Maya", type: "person" }],
  });
  await bank.remember({
    text: "Maya's dog is named Pepper",
    entities: [
      { name: "Maya", type: "person" },
      { name: "Pepper", type: "other" },
    ],
  });
  await bank.remember({ text: "Maya prefers morning meetings." });

  const facts = readRows<{ text: string }>(path, "SELECT text FROM facts ORDER BY text");
  expect(facts.map((row) => row.text)).toEqual([
    preference,
    "Maya prefers morning meetings.",
    "Maya's dog is named Pepper",
  ]);
  bank.close();
});

test("identical text in two banks stays two facts", async () => {
  const path = dbPath();
  const alpha = openBank(path, { bankId: "alpha" });
  const beta = openBank(path, { bankId: "beta" });
  const left = await alpha.remember({
    text: preference,
    entities: [{ name: "Maya", type: "person" }],
  });
  const right = await beta.remember({
    text: "  MAYA prefers morning meetings ",
    entities: [{ name: "Maya", type: "person" }],
  });

  expect(left.id).not.toBe(right.id);
  const facts = readRows<{ bank_id: string; text: string }>(
    path,
    "SELECT bank_id, text FROM facts ORDER BY bank_id",
  );
  expect(facts).toEqual([
    { bank_id: "alpha", text: preference },
    { bank_id: "beta", text: "MAYA prefers morning meetings" },
  ]);
  const entities = readRows<{ bank_id: string }>(path, "SELECT bank_id FROM entities ORDER BY bank_id");
  expect(entities.map((row) => row.bank_id)).toEqual(["alpha", "beta"]);
  alpha.close();
  beta.close();
});

test("opening a bank merges leftover identical facts and keeps the oldest", async () => {
  const path = dbPath();
  const created = openBank(path);
  created.close();
  seedDuplicates(path);

  const bank = openBank(path);
  const facts = readRows<{
    id: string;
    bank_id: string;
    text: string;
    occurrence_time: string | null;
    mentioned_at: string;
  }>(path, "SELECT id, bank_id, text, occurrence_time, mentioned_at FROM facts ORDER BY bank_id, id");

  expect(facts).toEqual([
    {
      id: "fact-beta",
      bank_id: "beta",
      text: preference,
      occurrence_time: "2024-02-02T00:00:00.000Z",
      mentioned_at: "2024-01-01T00:00:00.000Z",
    },
    {
      id: "fact-dog",
      bank_id: "default",
      text: "Maya's dog is named Pepper",
      occurrence_time: null,
      mentioned_at: "2024-03-01T00:00:00.000Z",
    },
    {
      id: "fact-key-old",
      bank_id: "default",
      text: "The spare key is under the mat",
      occurrence_time: "2024-01-02T03:00:00.000Z",
      mentioned_at: "2024-01-02T00:00:00.000Z",
    },
    {
      id: "fact-older",
      bank_id: "default",
      text: preference,
      occurrence_time: "2024-05-01T00:00:00.000Z",
      mentioned_at: "2024-01-01T00:00:00.000Z",
    },
  ]);

  const edges = readRows<{ fact_id: string; entity_id: string }>(
    path,
    "SELECT fact_id, entity_id FROM edges ORDER BY fact_id, entity_id",
  );
  expect(edges).toEqual([
    { fact_id: "fact-beta", entity_id: "ent-beta-maya" },
    { fact_id: "fact-older", entity_id: "ent-maya" },
    { fact_id: "fact-older", entity_id: "ent-pepper" },
  ]);
  expect(readRows(path, "SELECT id FROM sources")).toHaveLength(8);

  const recalled = await bank.recall({ query: "morning meetings", tokenBudget: 200 });
  expect(recalled.facts.map((fact) => fact.id)).toEqual(["fact-older"]);

  bank.close();
  const again = openBank(path);
  const ids = readRows<{ id: string }>(path, "SELECT id FROM facts ORDER BY id");
  expect(ids.map((row) => row.id)).toEqual(["fact-beta", "fact-dog", "fact-key-old", "fact-older"]);
  again.close();
});

function seedDuplicates(path: string): void {
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON;");
  const insertSource = db.query(
    `INSERT INTO sources (id, bank_id, text, context, speaker, mentioned_at, created_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
  );
  const insertEntity = db.query(
    `INSERT INTO entities (id, bank_id, canonical_name, aliases_json, type, created_at)
     VALUES (?, ?, ?, '[]', ?, ?)`,
  );
  const insertFact = db.query(
    `INSERT INTO facts (id, bank_id, text, kind, occurrence_time, mentioned_at, source_id, created_at)
     VALUES (?, ?, ?, 'world', ?, ?, ?, ?)`,
  );
  const insertEdge = db.query(
    `INSERT INTO edges (id, bank_id, edge_type, fact_id, entity_id)
     VALUES (?, ?, 'mentions', ?, ?)`,
  );

  insertSource.run("src-older", "default", "chat one", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
  insertSource.run("src-newer", "default", "chat two", "2024-06-02T00:00:00.000Z", "2024-06-02T00:00:00.000Z");
  insertSource.run("src-third", "default", "chat three", "2024-08-01T00:00:00.000Z", "2024-08-01T00:00:00.000Z");
  insertSource.run("src-dog", "default", "dog note", "2024-03-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z");
  insertSource.run("src-key-old", "default", "key note", "2024-01-02T00:00:00.000Z", "2024-01-02T00:00:00.000Z");
  insertSource.run("src-key-new", "default", "key note again", "2024-03-02T00:00:00.000Z", "2024-03-02T00:00:00.000Z");
  insertSource.run("src-beta", "beta", "beta chat", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
  insertSource.run("src-beta-dup", "beta", "beta chat again", "2024-04-01T00:00:00.000Z", "2024-04-01T00:00:00.000Z");

  insertEntity.run("ent-maya", "default", "Maya", "person", "2024-01-01T00:00:00.000Z");
  insertEntity.run("ent-pepper", "default", "Pepper", "other", "2024-06-02T00:00:00.000Z");
  insertEntity.run("ent-beta-maya", "beta", "Maya", "person", "2024-01-01T00:00:00.000Z");

  insertFact.run(
    "fact-older",
    "default",
    preference,
    null,
    "2024-01-01T00:00:00.000Z",
    "src-older",
    "2024-01-01T00:00:00.000Z",
  );
  insertFact.run(
    "fact-newer",
    "default",
    "  MAYA   prefers\nmorning meetings ",
    "2024-05-01T00:00:00.000Z",
    "2024-06-02T00:00:00.000Z",
    "src-newer",
    "2024-06-02T00:00:00.000Z",
  );
  insertFact.run(
    "fact-third",
    "default",
    "maya prefers morning meetings",
    null,
    "2024-08-01T00:00:00.000Z",
    "src-third",
    "2024-08-01T00:00:00.000Z",
  );
  insertFact.run(
    "fact-dog",
    "default",
    "Maya's dog is named Pepper",
    null,
    "2024-03-01T00:00:00.000Z",
    "src-dog",
    "2024-03-01T00:00:00.000Z",
  );
  insertFact.run(
    "fact-key-old",
    "default",
    "The spare key is under the mat",
    "2024-01-02T03:00:00.000Z",
    "2024-01-02T00:00:00.000Z",
    "src-key-old",
    "2024-01-02T00:00:00.000Z",
  );
  insertFact.run(
    "fact-key-new",
    "default",
    "the spare key is under the mat",
    "2024-09-09T00:00:00.000Z",
    "2024-03-02T00:00:00.000Z",
    "src-key-new",
    "2024-03-02T00:00:00.000Z",
  );
  insertFact.run(
    "fact-beta",
    "beta",
    preference,
    null,
    "2024-01-01T00:00:00.000Z",
    "src-beta",
    "2024-01-01T00:00:00.000Z",
  );
  insertFact.run(
    "fact-beta-dup",
    "beta",
    "maya prefers morning meetings",
    "2024-02-02T00:00:00.000Z",
    "2024-04-01T00:00:00.000Z",
    "src-beta-dup",
    "2024-04-01T00:00:00.000Z",
  );

  insertEdge.run("edge-maya", "default", "fact-older", "ent-maya");
  insertEdge.run("edge-pepper", "default", "fact-newer", "ent-pepper");
  insertEdge.run("edge-beta", "beta", "fact-beta", "ent-beta-maya");
  insertEdge.run("edge-beta-dup", "beta", "fact-beta-dup", "ent-beta-maya");
  db.close();
}
