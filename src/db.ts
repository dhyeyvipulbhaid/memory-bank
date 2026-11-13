import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertKeyCheck, createCryptoBox, keyCheckEnvelope } from "./crypto.ts";
import { dedupeIdenticalFacts } from "./dedupe.ts";
import { EncryptionError } from "./errors.ts";
import { pruneOrphanObservations } from "./reflect.ts";
import { migrateSchema, SCHEMA_SQL } from "./schema.ts";
import { attachBox } from "./sealed.ts";

const MARKER_KEY = "encryption";

export function openDatabase(path: string, key?: Uint8Array): Database {
  const db = openMigratedDatabase(path);
  bindEncryption(db, key);
  pruneOrphanObservations(db);
  dedupeIdenticalFacts(db);
  return db;
}

/** Schema only. Callers that encrypt an existing file use this so a missing key is not an error yet. */
export function openMigratedDatabase(path: string): Database {
  if (path !== ":memory:") {
    const directory = dirname(path);
    if (directory && directory !== ".") mkdirSync(directory, { recursive: true });
  }
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA_SQL);
  migrateSchema(db);
  return db;
}

export function readEncryptionMarker(db: Database): Uint8Array | null {
  const row = db.query("SELECT value FROM schema_meta WHERE key = ?").get(MARKER_KEY) as
    | { value: string }
    | null;
  if (!row) return null;
  const bytes = Buffer.from(row.value, "base64");
  return bytes.byteLength > 0 ? new Uint8Array(bytes) : null;
}

export function writeEncryptionMarker(db: Database, key: Uint8Array): void {
  const envelope = Buffer.from(keyCheckEnvelope(createCryptoBox(key))).toString("base64");
  db.query("INSERT INTO schema_meta (key, value) VALUES (?, ?)").run(MARKER_KEY, envelope);
}

function bindEncryption(db: Database, key: Uint8Array | undefined): void {
  const marker = readEncryptionMarker(db);
  if (marker) {
    if (!key) {
      throw new EncryptionError("This database is encrypted. Pass encryptionKey to openBank.");
    }
    const box = createCryptoBox(key);
    try {
      assertKeyCheck(box, marker);
    } catch (error) {
      if (error instanceof EncryptionError) throw new EncryptionError("Wrong encryption key.");
      throw error;
    }
    attachBox(db, box);
    return;
  }
  if (!key) return;
  if (databaseHasRows(db)) {
    throw new EncryptionError(
      "This database is not encrypted. Run encryptBank before opening it with a key.",
    );
  }
  const box = createCryptoBox(key);
  writeEncryptionMarker(db, key);
  attachBox(db, box);
}

function databaseHasRows(db: Database): boolean {
  const row = db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM facts)
         + (SELECT COUNT(*) FROM entities)
         + (SELECT COUNT(*) FROM sources)
         + (SELECT COUNT(*) FROM observations)
         + (SELECT COUNT(*) FROM source_chunks) AS n`,
    )
    .get() as { n: number | bigint };
  return Number(row.n) > 0;
}
