import { afterEach, expect, test } from "bun:test";
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

test("remember stores a knowledge disclaimer when the caller passes it", async () => {
  const path = dbPath();
  const text = "The assistant does not have specific information about a person named Pepper.";
  const bank = openBank(path, {
    extractor: createFakeExtractor(() => {
      throw new Error("extractor should not run for remember");
    }),
  });

  const fact = await bank.remember({
    text,
    entities: [{ name: "Pepper", type: "person" }],
  });

  expect(fact.text).toBe(text);
  const rows = readRows<{ text: string }>(path, "SELECT text FROM facts");
  expect(rows).toEqual([{ text }]);
  bank.close();
});

test("remember stores a manual fact without calling an extractor", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    extractor: createFakeExtractor(() => {
      throw new Error("extractor should not run for remember");
    }),
  });
  const fact = await bank.remember({
    text: "Maya prefers morning meetings.",
    kind: "world",
    entities: [{ name: "Maya", type: "person" }],
    occurrenceTime: "2024-05-01T00:00:00.000Z",
    mentionedAt: "2024-05-02T12:00:00.000Z",
  });

  expect(fact.text).toBe("Maya prefers morning meetings.");
  expect(fact.kind).toBe("world");
  expect(fact.occurrenceTime).toBe("2024-05-01T00:00:00.000Z");
  expect(fact.mentionedAt).toBe("2024-05-02T12:00:00.000Z");
  expect(fact.entities).toEqual([
    expect.objectContaining({ name: "Maya", type: "person" }),
  ]);

  const sources = readRows<{ text: string }>(path, "SELECT text FROM sources");
  expect(sources.map((row) => row.text)).toEqual(["Maya prefers morning meetings."]);
  bank.close();
});

test("Alice and Alice Chen resolve to one person, keeping the fuller name", async () => {
  const path = dbPath();
  const bank = openBank(path);

  const first = await bank.remember({
    text: "Alice sent the notes.",
    entities: [{ name: "Alice", type: "person" }],
  });
  const second = await bank.remember({
    text: "Alice Chen joined the design review.",
    entities: [{ name: "Alice Chen", type: "person" }],
  });

  expect(second.entities[0]?.id).toBe(first.entities[0]?.id);
  expect(second.entities[0]?.name).toBe("Alice Chen");

  const entities = readRows<{ canonical_name: string; aliases_json: string }>(
    path,
    "SELECT canonical_name, aliases_json FROM entities",
  );
  expect(entities).toHaveLength(1);
  expect(entities[0]?.canonical_name).toBe("Alice Chen");
  expect(JSON.parse(entities[0]?.aliases_json ?? "[]")).toContain("Alice");
  bank.close();
});

test("a later short mention of Alice reuses Alice Chen", async () => {
  const path = dbPath();
  const bank = openBank(path);
  const full = await bank.remember({
    text: "Alice Chen keeps the launch checklist.",
    entities: [{ name: "Alice Chen", type: "person" }],
  });
  const short = await bank.remember({
    text: "Alice updated the checklist.",
    entities: [{ name: "Alice", type: "person" }],
  });

  expect(short.entities[0]?.id).toBe(full.entities[0]?.id);
  expect(short.entities[0]?.name).toBe("Alice Chen");
  const entities = readRows<{ id: string }>(path, "SELECT id FROM entities");
  expect(entities).toHaveLength(1);
  bank.close();
});

test("distinct people who share a first name stay separate", async () => {
  const path = dbPath();
  const bank = openBank(path);
  const chen = await bank.remember({
    text: "Alice Chen runs design.",
    entities: [{ name: "Alice Chen", type: "person" }],
  });
  const wong = await bank.remember({
    text: "Alice Wong runs the bakery.",
    entities: [{ name: "Alice Wong", type: "person" }],
  });
  const ambiguous = await bank.remember({
    text: "Alice called.",
    entities: [{ name: "Alice", type: "person" }],
  });

  expect(chen.entities[0]?.id).not.toBe(wong.entities[0]?.id);
  expect(ambiguous.entities[0]?.id).not.toBe(chen.entities[0]?.id);
  expect(ambiguous.entities[0]?.id).not.toBe(wong.entities[0]?.id);
  const entities = readRows<{ canonical_name: string }>(
    path,
    "SELECT canonical_name FROM entities ORDER BY canonical_name",
  );
  expect(entities.map((row) => row.canonical_name)).toEqual([
    "Alice",
    "Alice Chen",
    "Alice Wong",
  ]);
  bank.close();
});

test("an ambiguous first name resolves by co-occurrence with other entities", async () => {
  const path = dbPath();
  const bank = openBank(path);
  const chen = await bank.remember({
    text: "Alice Chen published the Orbit notes with Sam Ortiz.",
    entities: [
      { name: "Alice Chen", type: "person" },
      { name: "Sam Ortiz", type: "person" },
      { name: "Orbit", type: "product" },
    ],
  });
  const wong = await bank.remember({
    text: "Alice Wong opened a bakery.",
    entities: [{ name: "Alice Wong", type: "person" }],
  });
  const later = await bank.remember({
    text: "Alice revised the Orbit notes.",
    entities: [
      { name: "Alice", type: "person" },
      { name: "Orbit", type: "product" },
    ],
  });

  const alice = later.entities.find((entity) => entity.type === "person");
  const chenId = chen.entities.find((entity) => entity.name === "Alice Chen")?.id;
  expect(alice?.id).toBe(chenId);
  expect(alice?.name).toBe("Alice Chen");
  expect(alice?.id).not.toBe(wong.entities[0]?.id);
  bank.close();
});

test("a one-character typo in a long name merges, a different short surname does not", async () => {
  const path = dbPath();
  const bank = openBank(path);
  const katherine = await bank.remember({
    text: "Katherine Johnson checked the figures.",
    entities: [{ name: "Katherine Johnson", type: "person" }],
  });
  const typo = await bank.remember({
    text: "Kathrine Johnson signed the sheet.",
    entities: [{ name: "Kathrine Johnson", type: "person" }],
  });
  const chen = await bank.remember({
    text: "Alice Chen filed the report.",
    entities: [{ name: "Alice Chen", type: "person" }],
  });
  const chan = await bank.remember({
    text: "Alice Chan filed a different report.",
    entities: [{ name: "Alice Chan", type: "person" }],
  });

  expect(typo.entities[0]?.id).toBe(katherine.entities[0]?.id);
  expect(chan.entities[0]?.id).not.toBe(chen.entities[0]?.id);
  bank.close();
});

test("banks in one file do not share facts or entities", async () => {
  const path = dbPath();
  const alpha = openBank(path, { bankId: "alpha" });
  const beta = openBank(path, { bankId: "beta" });
  await alpha.remember({
    text: "Only alpha knows the coral lantern passphrase.",
    entities: [{ name: "Coral Lantern", type: "concept" }],
  });
  await beta.remember({
    text: "Beta keeps a separate bakery note.",
    entities: [{ name: "Bakery", type: "place" }],
  });

  const facts = readRows<{ bank_id: string; text: string }>(
    path,
    "SELECT bank_id, text FROM facts ORDER BY bank_id",
  );
  expect(facts).toEqual([
    { bank_id: "alpha", text: "Only alpha knows the coral lantern passphrase." },
    { bank_id: "beta", text: "Beta keeps a separate bakery note." },
  ]);
  const entities = readRows<{ bank_id: string; canonical_name: string }>(
    path,
    "SELECT bank_id, canonical_name FROM entities ORDER BY bank_id, canonical_name",
  );
  expect(entities).toEqual([
    { bank_id: "alpha", canonical_name: "Coral Lantern" },
    { bank_id: "beta", canonical_name: "Bakery" },
  ]);
  alpha.close();
  beta.close();
});
