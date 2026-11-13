import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ReflectFailedError,
  ReflectorUnavailableError,
  createFakeEmbedder,
  createFakeReflector,
  createOllamaReflector,
  openBank,
} from "../src/index.ts";
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

const FACT = "Maya prefers morning meetings.";
const OBSERVATION = "Maya shows a morning-pattern.";

test("reflect stores an observation that cites the gathered fact and embeds it", async () => {
  const path = dbPath();
  let cited: string[] = [];
  const bank = openBank(path, {
    embedder: createFakeEmbedder((text) => (text === OBSERVATION ? [1, 0, 0] : [0, 1, 0])),
    reflector: createFakeReflector((input) => {
      cited = input.facts.map((fact) => fact.id);
      return [
        {
          text: OBSERVATION,
          confidence: 0.8,
          sourceFactIds: cited,
        },
      ];
    }),
  });
  const fact = await bank.remember({
    text: FACT,
    entities: [{ name: "Maya", type: "person" }],
  });

  const result = await bank.reflect({ query: "Maya" });
  expect(result.observations).toHaveLength(1);
  expect(result.observations[0]?.text).toBe(OBSERVATION);
  expect(result.observations[0]?.confidence).toBe(0.8);
  expect(result.observations[0]?.derived).toBe(true);
  expect(result.observations[0]?.sourceFactIds).toEqual([fact.id]);
  expect(result.removedIds).toEqual([]);

  const stored = readRows<{ embedding_dim: number | null; confidence: number }>(
    path,
    "SELECT embedding_dim, confidence FROM observations",
  );
  expect(stored).toEqual([{ embedding_dim: 3, confidence: 0.8 }]);

  const found = await bank.hybridRecall({ query: "morning-pattern", tokenBudget: 200 });
  expect(found.facts.map((item) => item.text)).toContain(OBSERVATION);
  const derived = found.facts.find((item) => item.text === OBSERVATION);
  expect(derived?.derived).toBe(true);
  expect(derived?.kind).toBe("observation");
  expect(derived?.sourceFactIds).toEqual([fact.id]);

  const hidden = await bank.hybridRecall({
    query: "morning-pattern",
    tokenBudget: 200,
    includeObservations: false,
  });
  expect(hidden.facts.map((item) => item.text)).not.toContain(OBSERVATION);
  bank.close();
});

test("reflect rejects observations that cite nothing or an unknown fact and writes nothing", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    reflector: createFakeReflector(() => [
      { text: "Maya likes quiet.", confidence: 0.4, sourceFactIds: [] },
      { text: "Maya likes noise.", confidence: 0.4, sourceFactIds: ["missing-fact"] },
    ]),
  });
  await bank.remember({ text: FACT, entities: [{ name: "Maya", type: "person" }] });
  await expect(bank.reflect({ query: "Maya" })).rejects.toBeInstanceOf(ReflectFailedError);
  expect(readRows(path, "SELECT id FROM observations")).toEqual([]);
  bank.close();
});

test("reflect drops a junk observation and keeps a cited one from the same reply", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    reflector: createFakeReflector((input) => [
      {
        text: "The assistant does not have specific information about a person named Pepper.",
        confidence: 0.9,
        sourceFactIds: [input.facts[0]?.id ?? ""],
      },
      {
        text: OBSERVATION,
        confidence: 0.7,
        sourceFactIds: input.facts.map((fact) => fact.id),
      },
    ]),
  });
  await bank.remember({ text: FACT, entities: [{ name: "Maya", type: "person" }] });
  const result = await bank.reflect({ query: "Maya" });
  expect(result.observations.map((item) => item.text)).toEqual([OBSERVATION]);
  bank.close();
});

test("re-running reflect updates the same observation and replaces a changed one", async () => {
  const path = dbPath();
  let generation = 0;
  const bank = openBank(path, {
    reflector: createFakeReflector((input) => {
      generation += 1;
      return [
        {
          text: generation === 1 ? OBSERVATION : "Maya keeps choosing mornings.",
          confidence: 0.6,
          sourceFactIds: input.facts.map((fact) => fact.id),
        },
      ];
    }),
  });
  await bank.remember({ text: FACT, entities: [{ name: "Maya", type: "person" }] });
  const first = await bank.reflect({ query: "Maya" });
  const second = await bank.reflect({ query: "Maya" });
  expect(second.observations).toHaveLength(1);
  expect(second.observations[0]?.id).not.toBe(first.observations[0]?.id);
  expect(second.removedIds).toEqual([first.observations[0]?.id]);
  expect(readRows(path, "SELECT id FROM observations")).toHaveLength(1);
  bank.close();

  const again = openBank(path, {
    reflector: createFakeReflector((input) => [
      {
        text: "Maya keeps choosing mornings.",
        confidence: 0.9,
        sourceFactIds: input.facts.map((fact) => fact.id),
      },
    ]),
  });
  const third = await again.reflect({ query: "Maya" });
  expect(third.observations[0]?.id).toBe(second.observations[0]?.id);
  expect(third.observations[0]?.confidence).toBe(0.9);
  expect(third.removedIds).toEqual([]);
  expect(readRows(path, "SELECT id FROM observations")).toHaveLength(1);
  again.close();
});

test("reflect stores at most the requested number of observations", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    reflector: createFakeReflector((input) =>
      ["one", "two", "three", "four"].map((word) => ({
        text: `Maya pattern ${word}.`,
        confidence: 0.5,
        sourceFactIds: input.facts.map((fact) => fact.id),
      })),
    ),
  });
  await bank.remember({ text: FACT, entities: [{ name: "Maya", type: "person" }] });
  const result = await bank.reflect({ query: "Maya", maxObservations: 2 });
  expect(result.observations.map((item) => item.text)).toEqual(["Maya pattern one.", "Maya pattern two."]);
  bank.close();
});

test("a down reflector writes nothing", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    reflector: createFakeReflector(() => {
      throw new ReflectorUnavailableError("Ollama is not reachable");
    }),
  });
  await bank.remember({ text: FACT, entities: [{ name: "Maya", type: "person" }] });
  await expect(bank.reflect({ query: "Maya" })).rejects.toBeInstanceOf(ReflectorUnavailableError);
  expect(readRows(path, "SELECT id FROM observations")).toEqual([]);
  const recalled = await bank.recall({ query: "Maya meetings", tokenBudget: 100 });
  expect(recalled.facts.map((fact) => fact.text)).toEqual([FACT]);
  bank.close();
});

test("forgetting a fact removes an observation that cited only that fact", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    reflector: createFakeReflector((input) => [
      {
        text: OBSERVATION,
        confidence: 0.5,
        sourceFactIds: input.facts.map((fact) => fact.id),
      },
    ]),
  });
  const fact = await bank.remember({ text: FACT, entities: [{ name: "Maya", type: "person" }] });
  await bank.reflect({ query: "Maya" });
  const removed = bank.forget(fact.id);
  expect(removed.removedObservationIds).toHaveLength(1);
  expect(readRows(path, "SELECT id FROM observations")).toEqual([]);
  expect(readRows(path, "SELECT id FROM facts")).toEqual([]);
  bank.close();
});

test("forgetting one cited fact keeps an observation that still has another source", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    reflector: createFakeReflector((input) => [
      {
        text: OBSERVATION,
        confidence: 0.5,
        sourceFactIds: input.facts.map((fact) => fact.id),
      },
    ]),
  });
  const first = await bank.remember({ text: FACT, entities: [{ name: "Maya", type: "person" }] });
  const second = await bank.remember({
    text: "Maya declined the afternoon slot.",
    entities: [{ name: "Maya", type: "person" }],
  });
  const saved = await bank.reflect({ query: "Maya" });
  expect(saved.observations[0]?.sourceFactIds.sort()).toEqual([first.id, second.id].sort());
  const removed = bank.forget(first.id);
  expect(removed.removedObservationIds).toEqual([]);
  const links = readRows<{ fact_id: string }>(path, "SELECT fact_id FROM observation_sources");
  expect(links.map((row) => row.fact_id)).toEqual([second.id]);
  bank.close();
});

test("opening a version 2 database adds observation tables and keeps facts", () => {
  const path = dbPath();
  const db = new Database(path);
  db.exec(VERSION_TWO_SQL);
  db.query(
    `INSERT INTO sources (id, bank_id, text, context, speaker, mentioned_at, created_at)
     VALUES ('s1', 'default', ?, NULL, NULL, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
  ).run(FACT);
  db.query(
    `INSERT INTO facts (
       id, bank_id, text, kind, occurrence_time, mentioned_at, source_id, created_at,
       embedding, embedding_model, embedding_dim
     ) VALUES ('f1', 'default', ?, 'world', NULL, '2024-01-01T00:00:00.000Z', 's1', '2024-01-01T00:00:00.000Z', NULL, NULL, NULL)`,
  ).run(FACT);
  db.close();

  const bank = openBank(path);
  const facts = readRows<{ id: string; text: string }>(path, "SELECT id, text FROM facts");
  expect(facts).toEqual([{ id: "f1", text: FACT }]);
  const version = readRows<{ value: string }>(path, "SELECT value FROM schema_meta WHERE key = 'version'");
  expect(version).toEqual([{ value: "3" }]);
  expect(readRows(path, "SELECT id FROM observations")).toEqual([]);
  bank.close();
});

test("the ollama reflector posts chat JSON with thinking disabled", async () => {
  let requestUrl = "";
  let body: { model?: string; think?: boolean; format?: string } = {};
  const reflector = createOllamaReflector({
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      body = JSON.parse(String(init?.body)) as typeof body;
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              observations: [{ text: "Maya prefers mornings.", confidence: 0.5, sourceFactIds: ["f1"] }],
            }),
          },
        }),
        { status: 200 },
      );
    },
  });
  const drafts = await reflector.reflect({
    facts: [{ id: "f1", text: FACT, kind: "world", mentionedAt: "2024-01-01T00:00:00.000Z" }],
  });
  expect(requestUrl).toBe("http://127.0.0.1:11434/api/chat");
  expect(body.model).toBe("qwen3:8b");
  expect(body.think).toBe(false);
  expect(body.format).toBe("json");
  expect(drafts[0]?.sourceFactIds).toEqual(["f1"]);
});

const VERSION_TWO_SQL = `
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO schema_meta (key, value) VALUES ('version', '2');
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  text TEXT NOT NULL,
  context TEXT,
  speaker TEXT,
  mentioned_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurrence_time TEXT,
  mentioned_at TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT,
  embedding_dim INTEGER
);
`;
