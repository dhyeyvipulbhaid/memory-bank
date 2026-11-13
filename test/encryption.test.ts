import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createCryptoBox } from "../src/crypto.ts";
import { EncryptionError } from "../src/errors.ts";
import { main } from "../src/cli.ts";
import {
  createFakeEmbedder,
  createFakeReflector,
  encryptBank,
  openBank,
  type HybridFact,
} from "../src/index.ts";
import { readRows, tempDbPath } from "./helpers.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  delete process.env.MEMORY_BANK_KEY;
});

function dbPath(): string {
  const created = tempDbPath();
  cleanups.push(created.cleanup);
  return created.path;
}

function key(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function fileBytes(path: string): Buffer {
  const db = new Database(path);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
  const chunks = [readFileSync(path)];
  for (const suffix of ["-wal", "-shm"]) {
    try {
      chunks.push(readFileSync(path + suffix));
    } catch {
      // The checkpoint removed the sidecar.
    }
  }
  return Buffer.concat(chunks);
}

function embed(text: string): number[] {
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = (hash * 33 + text.charCodeAt(index)) >>> 0;
  return [((hash & 255) + 1) / 256, (((hash >> 8) & 255) + 1) / 256, (((hash >> 16) & 255) + 1) / 256];
}

const SECRET = "Zephyrine keeps the cobalt key under the third stair.";
const JUNK = "The assistant does not have specific information about a person named Pepper.";

test("roundtrip, wrong key, missing key, tamper, swap, and unique IVs", async () => {
  const path = dbPath();
  const encryptionKey = key();
  const bank = openBank(path, { encryptionKey });
  await bank.remember({
    text: SECRET,
    entities: [{ name: "Zephyrine", type: "person" }],
    mentionedAt: "2024-06-01T00:00:00.000Z",
  });
  await bank.remember({
    text: "Zephyrine locked the blue tin.",
    entities: [{ name: "Zephyrine", type: "person" }],
    mentionedAt: "2024-06-02T00:00:00.000Z",
  });
  bank.close();

  const reopened = openBank(path, { encryptionKey: Buffer.from(encryptionKey).toString("base64") });
  const recalled = await reopened.recall({ query: "Zephyrine stair", tokenBudget: 400 });
  expect(recalled.facts.map((fact) => fact.text)).toContain(SECRET);
  expect(recalled.facts[0]?.entities.map((entity) => entity.name)).toContain("Zephyrine");
  reopened.close();

  const raw = fileBytes(path);
  expect(raw.includes(Buffer.from(SECRET))).toBe(false);
  expect(raw.includes(Buffer.from("Zephyrine"))).toBe(false);
  expect(raw.includes(Buffer.from("memory-bank-ok"))).toBe(false);

  const blobs = readRows<{ id: string; text_enc: Uint8Array }>(
    path,
    "SELECT id, text_enc FROM facts ORDER BY mentioned_at",
  );
  expect(blobs).toHaveLength(2);
  expect(Buffer.from(blobs[0]!.text_enc.subarray(1, 13)).equals(Buffer.from(blobs[1]!.text_enc.subarray(1, 13)))).toBe(
    false,
  );

  const box = createCryptoBox(encryptionKey);
  const left = box.encrypt(Buffer.from("same"), "facts|text|a");
  const right = box.encrypt(Buffer.from("same"), "facts|text|a");
  expect(Buffer.from(left.subarray(1, 13)).equals(Buffer.from(right.subarray(1, 13)))).toBe(false);

  expect(() => openBank(path)).toThrow(EncryptionError);
  expect(() => openBank(path)).toThrow(/encrypted/);
  expect(() => openBank(path, { encryptionKey: key() })).toThrow(/Wrong encryption key/);

  const tampered = new Uint8Array(blobs[0]!.text_enc);
  tampered[20] ^= 0xff;
  const editor = new Database(path);
  editor.query("UPDATE facts SET text_enc = ? WHERE id = ?").run(tampered, blobs[0]!.id);
  editor.close();
  expect(() => openBank(path, { encryptionKey })).toThrow(/Ciphertext failed authentication/);

  const restored = new Database(path);
  restored.query("UPDATE facts SET text_enc = ? WHERE id = ?").run(blobs[1]!.text_enc, blobs[0]!.id);
  restored.query("UPDATE facts SET text_enc = ? WHERE id = ?").run(blobs[0]!.text_enc, blobs[1]!.id);
  restored.close();
  expect(() => openBank(path, { encryptionKey })).toThrow(/Ciphertext failed authentication/);
});

test("plaintext mode still stores text and refuses a key until encryptBank", async () => {
  const path = dbPath();
  const bank = openBank(path);
  await bank.remember({ text: SECRET, entities: [{ name: "Zephyrine", type: "person" }] });
  const recalled = await bank.recall({ query: "Zephyrine", tokenBudget: 200 });
  expect(recalled.facts.map((fact) => fact.text)).toEqual([SECRET]);
  bank.close();
  expect(fileBytes(path).includes(Buffer.from(SECRET))).toBe(true);
  expect(readRows(path, "SELECT value FROM schema_meta WHERE key = 'version'")).toEqual([{ value: "4" }]);
  expect(() => openBank(path, { encryptionKey: key() })).toThrow(/not encrypted/);
});

test("encryptBank migrates a plaintext v3 database, is idempotent, and supports dry-run", async () => {
  const path = dbPath();
  const db = new Database(path);
  db.exec(VERSION_THREE_SQL);
  db.query(
    `INSERT INTO sources (id, bank_id, text, context, speaker, mentioned_at, created_at)
     VALUES ('s1', 'default', ?, 'desk', 'Zephyrine', '2024-04-01T00:00:00.000Z', '2024-04-01T00:00:00.000Z')`,
  ).run(SECRET);
  db.query(
    `INSERT INTO source_chunks (id, bank_id, source_id, ordinal, text) VALUES ('c1', 'default', 's1', 0, ?)`,
  ).run(SECRET);
  db.query(
    `INSERT INTO entities (id, bank_id, canonical_name, aliases_json, type, created_at)
     VALUES ('e1', 'default', 'Zephyrine', '["Zee"]', 'person', '2024-04-01T00:00:00.000Z')`,
  ).run();
  db.query(
    `INSERT INTO facts (
       id, bank_id, text, kind, occurrence_time, mentioned_at, source_id, created_at,
       embedding, embedding_model, embedding_dim
     ) VALUES ('f1', 'default', ?, 'world', NULL, '2024-04-01T00:00:00.000Z', 's1', '2024-04-01T00:00:00.000Z', NULL, NULL, NULL)`,
  ).run(SECRET);
  db.query(
    `INSERT INTO edges (id, bank_id, edge_type, fact_id, entity_id) VALUES ('g1', 'default', 'mentions', 'f1', 'e1')`,
  ).run();
  db.query(
    `INSERT INTO observations (
       id, bank_id, scope_key, text, confidence, created_at, updated_at
     ) VALUES ('o1', 'default', 'scope', ?, 0.8, '2024-04-01T00:00:00.000Z', '2024-04-01T00:00:00.000Z')`,
  ).run("Zephyrine uses the stair.");
  db.query(
    `INSERT INTO observation_sources (observation_id, fact_id, bank_id) VALUES ('o1', 'f1', 'default')`,
  ).run();
  db.close();

  const encryptionKey = key();
  const preview = encryptBank(path, encryptionKey, { dryRun: true });
  expect(preview.dryRun).toBe(true);
  expect(preview.alreadyEncrypted).toBe(false);
  expect(preview.fields).toBeGreaterThan(0);
  expect(fileBytes(path).includes(Buffer.from(SECRET))).toBe(true);

  const converted = encryptBank(path, encryptionKey);
  expect(converted.alreadyEncrypted).toBe(false);
  expect(converted.fields).toBe(preview.fields);
  const raw = fileBytes(path);
  expect(raw.includes(Buffer.from(SECRET))).toBe(false);
  expect(raw.includes(Buffer.from("Zephyrine"))).toBe(false);
  expect(raw.includes(Buffer.from("Zephyrine uses the stair."))).toBe(false);

  const bank = openBank(path, { encryptionKey });
  const recalled = await bank.recall({ query: "Zephyrine stair", tokenBudget: 200 });
  expect(recalled.facts.map((fact) => fact.text)).toEqual([SECRET]);
  expect(recalled.facts[0]?.entities[0]?.name).toBe("Zephyrine");
  bank.close();

  expect(encryptBank(path, encryptionKey)).toEqual({ dryRun: false, alreadyEncrypted: true, fields: 0 });
  expect(() => encryptBank(path, key())).toThrow(/Wrong encryption key/);
});

test("recall, hybrid, reflect, sweep, and graph match a plaintext bank", async () => {
  const plainPath = dbPath();
  const sealedPath = dbPath();
  const encryptionKey = key();
  const plain = await seed(plainPath);
  const sealed = await seed(sealedPath, encryptionKey);

  const plainRecall = await plain.recall({ query: "Maya Jordan", tokenBudget: 800 });
  const sealedRecall = await sealed.recall({ query: "Maya Jordan", tokenBudget: 800 });
  expect(projectFacts(sealedRecall.facts)).toEqual(projectFacts(plainRecall.facts));

  const now = "2024-06-10T00:00:00.000Z";
  const plainHybrid = await plain.hybridRecall({ query: "Maya Jordan", tokenBudget: 800, now, includeObservations: false });
  const sealedHybrid = await sealed.hybridRecall({
    query: "Maya Jordan",
    tokenBudget: 800,
    now,
    includeObservations: false,
  });
  // Fusion breaks score ties by row id, so the sealed bank's ids move the RRF score slightly.
  expect(byText(sealedHybrid.facts)).toEqual(byText(plainHybrid.facts));

  const plainReflect = await plain.reflect({ query: "Maya Jordan", now });
  const sealedReflect = await sealed.reflect({ query: "Maya Jordan", now });
  expect(sealedReflect.observations.map((row) => row.text)).toEqual(plainReflect.observations.map((row) => row.text));

  const plainSweep = plain.sweepJunk();
  const sealedSweep = sealed.sweepJunk();
  expect(sealedSweep.candidates.map((row) => ({ text: row.text, reason: row.reason }))).toEqual(
    plainSweep.candidates.map((row) => ({ text: row.text, reason: row.reason })),
  );

  const plainGraph = plain.graphSnapshot({ includeObservations: true, now });
  const sealedGraph = sealed.graphSnapshot({ includeObservations: true, now });
  expect(sealedGraph.nodes.map((node) => node.label).sort()).toEqual(plainGraph.nodes.map((node) => node.label).sort());
  expect(sealedGraph.edges.map((edge) => edge.type).sort()).toEqual(plainGraph.edges.map((edge) => edge.type).sort());

  plain.close();
  sealed.close();
  expect(fileBytes(sealedPath).includes(Buffer.from("Maya met Jordan on Monday."))).toBe(false);
  expect(fileBytes(plainPath).includes(Buffer.from("Maya met Jordan on Monday."))).toBe(true);
});

test("encrypt CLI dry-run counts and --key-env opens the converted file", async () => {
  const path = dbPath();
  const bank = openBank(path);
  await bank.remember({ text: SECRET });
  bank.close();
  const encryptionKey = key();
  process.env.MEMORY_BANK_KEY = Buffer.from(encryptionKey).toString("base64");
  expect(await main(["encrypt", "--db", path, "--key-env", "MEMORY_BANK_KEY", "--dry-run"])).toBe(0);
  expect(fileBytes(path).includes(Buffer.from(SECRET))).toBe(true);
  expect(await main(["encrypt", "--db", path, "--key-env", "MEMORY_BANK_KEY"])).toBe(0);
  expect(fileBytes(path).includes(Buffer.from(SECRET))).toBe(false);
  expect(await main(["recall", "--db", path, "--key-env", "MEMORY_BANK_KEY", "--query", "Zephyrine stair", "--token-budget", "200"])).toBe(0);
});

async function seed(path: string, encryptionKey?: Uint8Array) {
  const bank = openBank(path, {
    encryptionKey,
    embedder: createFakeEmbedder(embed),
    reflector: createFakeReflector((input) => [
      {
        text: "Maya met Jordan more than once.",
        confidence: 0.9,
        sourceFactIds: input.facts.map((fact) => fact.id),
      },
    ]),
  });
  await bank.remember({
    text: "Maya met Jordan on Monday.",
    entities: [
      { name: "Maya", type: "person" },
      { name: "Jordan", type: "person" },
    ],
    mentionedAt: "2024-06-03T00:00:00.000Z",
  });
  await bank.remember({
    text: "Maya met Jordan again on Wednesday.",
    entities: [
      { name: "Maya", type: "person" },
      { name: "Jordan", type: "person" },
    ],
    mentionedAt: "2024-06-05T00:00:00.000Z",
  });
  await bank.remember({ text: JUNK, mentionedAt: "2024-06-06T00:00:00.000Z" });
  return bank;
}

function projectFacts(
  facts: Array<{ text: string; score: number; entities: Array<{ name: string }> }>,
): Array<{ text: string; score: number; names: string[] }> {
  return facts.map((fact) => ({
    text: fact.text,
    score: fact.score,
    names: fact.entities.map((entity) => entity.name).sort(),
  }));
}

function byText(facts: HybridFact[]): Array<{ text: string; derived: boolean; recency: number }> {
  return facts
    .map((fact) => ({ text: fact.text, derived: fact.derived, recency: fact.breakdown.recency }))
    .sort((left, right) => (left.text < right.text ? -1 : left.text > right.text ? 1 : 0));
}

const VERSION_THREE_SQL = `
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO schema_meta (key, value) VALUES ('version', '3');
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
  source_id TEXT NOT NULL,
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
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT,
  embedding_dim INTEGER
);
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  entity_id TEXT NOT NULL
);
CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT,
  embedding_dim INTEGER
);
CREATE TABLE observation_sources (
  observation_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  PRIMARY KEY (observation_id, fact_id)
);
`;
