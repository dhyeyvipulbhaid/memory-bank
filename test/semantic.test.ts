import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  EmbedderUnavailableError,
  createFakeEmbedder,
  createFakeExtractor,
  estimateTokens,
  openBank,
} from "../src/index.ts";
import { meaningfulTokens } from "../src/tokens.ts";
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

const CANINE = "The canine companion enjoys chasing spherical toys.";
const BINDER = "Quarterly revenue is filed in the blue binder.";
const PARAPHRASE = "dog plays fetch";

function overlap(left: string, right: string): string[] {
  const words = new Set(meaningfulTokens(right));
  return meaningfulTokens(left).filter((token) => words.has(token));
}

function scripted(map: Record<string, readonly number[]>, model = "fake-embed") {
  return createFakeEmbedder((text) => {
    const vector = map[text];
    if (!vector) throw new Error(`no vector scripted for: ${text}`);
    return vector;
  }, { model });
}

test("semantic search finds a paraphrase that shares no keywords", async () => {
  expect(overlap(CANINE, PARAPHRASE)).toEqual([]);
  expect(overlap(BINDER, PARAPHRASE)).toEqual([]);

  const path = dbPath();
  const embedder = scripted({
    [CANINE]: [1, 0, 0],
    [BINDER]: [0, 1, 0],
    [PARAPHRASE]: [0.8, 0, 0],
  });
  const bank = openBank(path, { embedder });

  await bank.remember({
    text: BINDER,
    entities: [{ name: "Binder", type: "other" }],
  });
  await bank.remember({
    text: CANINE,
    entities: [{ name: "Companion", type: "other" }],
  });

  const keyword = await bank.recall({ query: PARAPHRASE, tokenBudget: 400 });
  expect(keyword.facts).toEqual([]);

  const semantic = await bank.semanticSearch({
    query: PARAPHRASE,
    tokenBudget: 400,
    limit: 2,
  });

  expect(semantic.facts.map((fact) => fact.text)).toEqual([CANINE]);
  expect(semantic.facts[0]?.score).toBeGreaterThan(0.9);
  expect(semantic.tokensUsed).toBe(estimateTokens(CANINE));
  expect(semantic.facts[0]?.entities.map((entity) => entity.name)).toEqual(["Companion"]);

  const stored = readRows<{
    embedding: Uint8Array | null;
    embedding_model: string | null;
    embedding_dim: number | null;
  }>(path, "SELECT embedding, embedding_model, embedding_dim FROM facts WHERE text = ?", CANINE);
  expect(stored[0]?.embedding_model).toBe("fake-embed");
  expect(stored[0]?.embedding_dim).toBe(3);
  expect(stored[0]?.embedding).toBeInstanceOf(Uint8Array);
  expect(stored[0]?.embedding?.byteLength).toBe(12);
  bank.close();
});

test("semantic search keeps the higher-scoring fact when the budget fits only a shorter one", async () => {
  const path = dbPath();
  const shortText = "Cat naps.";
  const longText = `Feline sleeps. ${"extra detail ".repeat(30)}`;
  const query = "sleeping animal";
  const bank = openBank(path, {
    embedder: scripted({
      [shortText]: [0.2, 1, 0],
      [longText]: [1, 0, 0],
      [query]: [1, 0, 0],
    }),
  });
  await bank.remember({ text: shortText });
  await bank.remember({ text: longText });

  const budget = estimateTokens(shortText);
  expect(estimateTokens(longText)).toBeGreaterThan(budget);
  const result = await bank.semanticSearch({ query, tokenBudget: budget, limit: 5 });
  expect(result.facts.map((fact) => fact.text)).toEqual([shortText]);
  expect(result.tokensUsed).toBeLessThanOrEqual(budget);
  bank.close();
});

test("semantic search stops after the requested limit", async () => {
  const path = dbPath();
  const first = "Alpha signal is stored near the dock.";
  const second = "Beta signal is stored near the pier.";
  const query = "harbor signal";
  const bank = openBank(path, {
    embedder: scripted({
      [first]: [1, 0],
      [second]: [0.9, 0.1],
      [query]: [1, 0],
    }),
  });
  await bank.remember({ text: second });
  await bank.remember({ text: first });

  const result = await bank.semanticSearch({ query, tokenBudget: 500, limit: 1 });
  expect(result.facts.map((fact) => fact.text)).toEqual([first]);
  bank.close();
});

test("semantic search ignores vectors stored for a different model", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    embedder: scripted({ [CANINE]: [1, 0] }, "model-a"),
  });
  await bank.remember({ text: CANINE });
  bank.close();

  const other = openBank(path, {
    embedder: scripted({ [PARAPHRASE]: [1, 0] }, "model-b"),
  });
  const result = await other.semanticSearch({ query: PARAPHRASE, tokenBudget: 200 });
  expect(result.facts).toEqual([]);
  other.close();
});

test("semantic search reports an embedder failure and leaves keyword recall working", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    embedder: createFakeEmbedder((text) => {
      if (text === CANINE) return [1, 0];
      throw new EmbedderUnavailableError("Ollama is not reachable");
    }),
  });
  await bank.remember({ text: CANINE });
  await expect(
    bank.semanticSearch({ query: PARAPHRASE, tokenBudget: 100 }),
  ).rejects.toBeInstanceOf(EmbedderUnavailableError);
  const recalled = await bank.recall({ query: "canine toys", tokenBudget: 100 });
  expect(recalled.facts.map((fact) => fact.text)).toEqual([CANINE]);
  bank.close();
});

test("semantic search stays inside one bank id", async () => {
  const path = dbPath();
  const embedder = scripted({
    [CANINE]: [1, 0],
    [PARAPHRASE]: [1, 0],
  });
  const alpha = openBank(path, { bankId: "alpha", embedder });
  const beta = openBank(path, { bankId: "beta", embedder });
  await alpha.remember({ text: CANINE });
  const result = await beta.semanticSearch({ query: PARAPHRASE, tokenBudget: 200 });
  expect(result.facts).toEqual([]);
  alpha.close();
  beta.close();
});

test("backfill embeds facts that have no vector and does nothing the second time", async () => {
  const path = dbPath();
  const plain = openBank(path);
  await plain.remember({ text: CANINE });
  await plain.remember({ text: BINDER });
  plain.close();

  let calls = 0;
  const embedder = createFakeEmbedder((text) => {
    calls += 1;
    if (text === CANINE) return [1, 0, 0];
    if (text === BINDER) return [0, 1, 0];
    if (text === PARAPHRASE) return [0.8, 0.05, 0];
    throw new Error(`no vector scripted for: ${text}`);
  });
  const bank = openBank(path, { embedder });
  const filled = await bank.backfillEmbeddings();
  expect(filled).toEqual({ embedded: 2, remaining: 0 });
  expect(calls).toBe(2);

  const again = await bank.backfillEmbeddings();
  expect(again).toEqual({ embedded: 0, remaining: 0 });
  expect(calls).toBe(2);

  const semantic = await bank.semanticSearch({ query: PARAPHRASE, tokenBudget: 400, limit: 1 });
  expect(semantic.facts.map((fact) => fact.text)).toEqual([CANINE]);
  bank.close();
});

test("backfill keeps vectors already written when a later fact fails", async () => {
  const path = dbPath();
  const plain = openBank(path);
  await plain.remember({ text: "First fact without a vector." });
  await plain.remember({ text: "Second fact without a vector." });
  plain.close();

  let calls = 0;
  const flaky = createFakeEmbedder(() => {
    calls += 1;
    if (calls > 1) throw new EmbedderUnavailableError("Ollama stopped");
    return [1, 0];
  });
  const bank = openBank(path, { embedder: flaky });
  await expect(bank.backfillEmbeddings()).rejects.toBeInstanceOf(EmbedderUnavailableError);
  const midway = readRows<{ embedding: Uint8Array | null }>(
    path,
    "SELECT embedding FROM facts ORDER BY created_at, id",
  );
  expect(midway.filter((row) => row.embedding != null)).toHaveLength(1);
  expect(midway.filter((row) => row.embedding == null)).toHaveLength(1);
  bank.close();

  const retry = openBank(path, {
    embedder: createFakeEmbedder(() => [0, 1]),
  });
  const finished = await retry.backfillEmbeddings();
  expect(finished).toEqual({ embedded: 1, remaining: 0 });
  const done = readRows<{ embedding: Uint8Array | null }>(path, "SELECT embedding FROM facts");
  expect(done.every((row) => row.embedding != null)).toBe(true);
  retry.close();
});

test("retain and remember still store facts when the embedder is down", async () => {
  const path = dbPath();
  const down = createFakeEmbedder(() => {
    throw new EmbedderUnavailableError("Ollama is not reachable");
  });
  const bank = openBank(path, {
    embedder: down,
    extractor: createFakeExtractor(() => [
      {
        text: "Nia keeps a red notebook.",
        kind: "world",
        occurrenceTime: null,
        entities: [{ name: "Nia", type: "person" }],
      },
    ]),
  });

  const retained = await bank.retain({
    content: "Nia keeps a red notebook in her bag.",
    mentionedAt: "2024-07-01T00:00:00.000Z",
  });
  expect(retained.facts.map((fact) => fact.text)).toEqual(["Nia keeps a red notebook."]);

  const manual = await bank.remember({
    text: "Maya prefers morning meetings.",
    entities: [{ name: "Maya", type: "person" }],
  });
  expect(manual.text).toBe("Maya prefers morning meetings.");

  const vectors = readRows<{ embedding: Uint8Array | null }>(path, "SELECT embedding FROM facts");
  expect(vectors).toHaveLength(2);
  expect(vectors.every((row) => row.embedding == null)).toBe(true);

  const recalled = await bank.recall({ query: "Maya meetings", tokenBudget: 100 });
  expect(recalled.facts.map((fact) => fact.text)).toEqual(["Maya prefers morning meetings."]);
  bank.close();
});

test("retain stores an embedding for each kept fact", async () => {
  const path = dbPath();
  const text = "Nia keeps a red notebook.";
  const bank = openBank(path, {
    embedder: scripted({ [text]: [0, 1, 0] }),
    extractor: createFakeExtractor(() => [
      {
        text,
        kind: "world",
        occurrenceTime: null,
        entities: [{ name: "Nia", type: "person" }],
      },
    ]),
  });
  await bank.retain({ content: "Nia keeps a red notebook in her bag." });
  const rows = readRows<{ embedding_dim: number | null }>(
    path,
    "SELECT embedding_dim FROM facts",
  );
  expect(rows).toEqual([{ embedding_dim: 3 }]);
  bank.close();
});

test("opening a version 1 database adds embedding columns and keeps rows", () => {
  const path = dbPath();
  const db = new Database(path);
  db.exec(VERSION_ONE_SQL);
  const sourceId = "source-1";
  const factId = "fact-1";
  const now = "2024-01-01T00:00:00.000Z";
  db.query(
    `INSERT INTO sources (id, bank_id, text, context, speaker, mentioned_at, created_at)
     VALUES (?, 'default', ?, NULL, NULL, ?, ?)`,
  ).run(sourceId, "Maya prefers morning meetings.", now, now);
  db.query(
    `INSERT INTO facts (id, bank_id, text, kind, occurrence_time, mentioned_at, source_id, created_at)
     VALUES (?, 'default', ?, 'world', NULL, ?, ?, ?)`,
  ).run(factId, "Maya prefers morning meetings.", now, sourceId, now);
  db.close();

  const bank = openBank(path);
  const facts = readRows<{
    id: string;
    text: string;
    embedding: Uint8Array | null;
    embedding_model: string | null;
    embedding_dim: number | null;
  }>(path, "SELECT id, text, embedding, embedding_model, embedding_dim FROM facts");
  expect(facts).toEqual([
    {
      id: factId,
      text: "Maya prefers morning meetings.",
      embedding: null,
      embedding_model: null,
      embedding_dim: null,
    },
  ]);
  const version = readRows<{ value: string }>(
    path,
    "SELECT value FROM schema_meta WHERE key = 'version'",
  );
  expect(version).toEqual([{ value: "4" }]);
  bank.close();
});

test("dedupe copies a vector onto the older duplicate when that row has none", async () => {
  const path = dbPath();
  const seeded = openBank(path);
  const kept = await seeded.remember({
    text: "Maya prefers morning meetings.",
    mentionedAt: "2024-01-01T00:00:00.000Z",
  });
  seeded.close();

  const raw = new Database(path);
  raw.query(
    `INSERT INTO facts (
       id, bank_id, text, kind, occurrence_time, mentioned_at, source_id, created_at,
       embedding, embedding_model, embedding_dim
     ) VALUES ('newer', 'default', 'Maya prefers morning meetings.', 'world', NULL, ?, ?, ?, ?, 'fake-embed', 1)`,
  ).run(
    "2099-06-01T00:00:00.000Z",
    kept.sourceId,
    "2099-06-01T00:00:00.000Z",
    new Uint8Array([0, 0, 128, 63]),
  );
  raw.close();

  const bank = openBank(path);
  const facts = readRows<{ id: string; embedding_model: string | null; embedding_dim: number | null }>(
    path,
    "SELECT id, embedding_model, embedding_dim FROM facts",
  );
  expect(facts).toEqual([{ id: kept.id, embedding_model: "fake-embed", embedding_dim: 1 }]);
  bank.close();
});

const VERSION_ONE_SQL = `
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO schema_meta (key, value) VALUES ('version', '1');
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  text TEXT NOT NULL,
  context TEXT,
  speaker TEXT,
  mentioned_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE source_chunks (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurrence_time TEXT,
  mentioned_at TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id),
  created_at TEXT NOT NULL
);
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  fact_id TEXT NOT NULL REFERENCES facts(id),
  entity_id TEXT NOT NULL REFERENCES entities(id)
);
`;
