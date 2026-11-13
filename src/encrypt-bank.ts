import { dedupeIdenticalFacts, normalizeFactText } from "./dedupe.ts";
import { EncryptionError } from "./errors.ts";
import { normalizeName } from "./names.ts";
import { pruneOrphanObservations } from "./reflect.ts";
import {
  openMigratedDatabase,
  readEncryptionMarker,
  writeEncryptionMarker,
} from "./db.ts";
import { aad, assertKeyCheck, createCryptoBox, type CryptoBox } from "./crypto.ts";
import { asBytes } from "./sealed.ts";

export interface EncryptBankResult {
  dryRun: boolean;
  alreadyEncrypted: boolean;
  /** Plaintext fields that were encrypted, or that would be on a dry run. */
  fields: number;
}

/**
 * Convert a plaintext database in one transaction.
 * Back up the file first. A second call with the same key reports alreadyEncrypted.
 */
export function encryptBank(
  dbPath: string,
  key: Uint8Array,
  options: { dryRun?: boolean } = {},
): EncryptBankResult {
  const dryRun = options.dryRun ?? false;
  const db = openMigratedDatabase(dbPath);
  try {
    const marker = readEncryptionMarker(db);
    if (marker) {
      try {
        assertKeyCheck(createCryptoBox(key), marker);
      } catch (error) {
        if (error instanceof EncryptionError) throw new EncryptionError("Wrong encryption key.");
        throw error;
      }
      return { dryRun, alreadyEncrypted: true, fields: 0 };
    }
    if (dryRun) return { dryRun: true, alreadyEncrypted: false, fields: countPlainFields(db) };
    pruneOrphanObservations(db);
    dedupeIdenticalFacts(db);
    const fields = countPlainFields(db);
    const box = createCryptoBox(key);
    const convert = db.transaction(() => {
      encryptSources(db, box);
      encryptChunks(db, box);
      encryptEntities(db, box);
      encryptFacts(db, box);
      encryptObservations(db, box);
      writeEncryptionMarker(db, key);
    });
    convert();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.exec("VACUUM;");
    return { dryRun: false, alreadyEncrypted: false, fields };
  } finally {
    db.close();
  }
}

function countPlainFields(db: ReturnType<typeof openMigratedDatabase>): number {
  let fields = 0;
  const sources = db.query("SELECT context, speaker FROM sources").all() as Array<{
    context: string | null;
    speaker: string | null;
  }>;
  for (const row of sources) {
    fields += 1;
    if (row.context != null) fields += 1;
    if (row.speaker != null) fields += 1;
  }
  const chunks = db.query("SELECT COUNT(*) AS n FROM source_chunks").get() as { n: number | bigint };
  fields += Number(chunks.n);
  const entities = db.query("SELECT aliases_json FROM entities").all() as Array<{ aliases_json: string }>;
  for (const row of entities) {
    fields += 1;
    if (aliasList(row.aliases_json).length > 0) fields += 1;
  }
  const facts = db.query("SELECT embedding FROM facts").all() as Array<{ embedding: unknown }>;
  for (const row of facts) {
    fields += 1;
    if (asBytes(row.embedding)) fields += 1;
  }
  const observations = db.query("SELECT embedding FROM observations").all() as Array<{ embedding: unknown }>;
  for (const row of observations) {
    fields += 1;
    if (asBytes(row.embedding)) fields += 1;
  }
  return fields;
}

function encryptSources(db: ReturnType<typeof openMigratedDatabase>, box: CryptoBox): void {
  const rows = db.query("SELECT id, text, context, speaker FROM sources").all() as Array<{
    id: string;
    text: string;
    context: string | null;
    speaker: string | null;
  }>;
  const update = db.query(
    `UPDATE sources
     SET text = '', text_enc = ?, context = NULL, context_enc = ?, speaker = NULL, speaker_enc = ?
     WHERE id = ?`,
  );
  for (const row of rows) {
    update.run(
      box.encrypt(utf8(row.text), aad("sources", "text", row.id)),
      row.context == null ? null : box.encrypt(utf8(row.context), aad("sources", "context", row.id)),
      row.speaker == null ? null : box.encrypt(utf8(row.speaker), aad("sources", "speaker", row.id)),
      row.id,
    );
  }
}

function encryptChunks(db: ReturnType<typeof openMigratedDatabase>, box: CryptoBox): void {
  const rows = db.query("SELECT id, text FROM source_chunks").all() as Array<{ id: string; text: string }>;
  const update = db.query("UPDATE source_chunks SET text = '', text_enc = ? WHERE id = ?");
  for (const row of rows) {
    update.run(box.encrypt(utf8(row.text), aad("source_chunks", "text", row.id)), row.id);
  }
}

function encryptEntities(db: ReturnType<typeof openMigratedDatabase>, box: CryptoBox): void {
  const rows = db.query("SELECT id, bank_id, canonical_name, aliases_json FROM entities").all() as Array<{
    id: string;
    bank_id: string;
    canonical_name: string;
    aliases_json: string;
  }>;
  const update = db.query(
    `UPDATE entities
     SET canonical_name = '', canonical_name_enc = ?, aliases_json = '[]', aliases_enc = ?, name_idx = ?
     WHERE id = ?`,
  );
  const clear = db.query("DELETE FROM entity_name_index WHERE bank_id = ? AND entity_id = ?");
  const insert = db.query(
    "INSERT OR IGNORE INTO entity_name_index (bank_id, entity_id, name_idx) VALUES (?, ?, ?)",
  );
  for (const row of rows) {
    const aliases = aliasList(row.aliases_json);
    update.run(
      box.encrypt(utf8(row.canonical_name), aad("entities", "canonical_name", row.id)),
      aliases.length === 0 ? null : box.encrypt(utf8(JSON.stringify(aliases)), aad("entities", "aliases", row.id)),
      box.blind(normalizeName(row.canonical_name)),
      row.id,
    );
    clear.run(row.bank_id, row.id);
    for (const name of [row.canonical_name, ...aliases]) {
      const normalized = normalizeName(name);
      if (!normalized) continue;
      insert.run(row.bank_id, row.id, box.blind(normalized));
    }
  }
}

function encryptFacts(db: ReturnType<typeof openMigratedDatabase>, box: CryptoBox): void {
  const rows = db.query("SELECT id, text, embedding FROM facts").all() as Array<{
    id: string;
    text: string;
    embedding: unknown;
  }>;
  const update = db.query(
    "UPDATE facts SET text = '', text_enc = ?, text_idx = ?, embedding = ? WHERE id = ?",
  );
  for (const row of rows) {
    const embedding = asBytes(row.embedding);
    update.run(
      box.encrypt(utf8(row.text), aad("facts", "text", row.id)),
      box.blind(normalizeFactText(row.text)),
      embedding ? box.encrypt(embedding, aad("facts", "embedding", row.id)) : null,
      row.id,
    );
  }
}

function encryptObservations(db: ReturnType<typeof openMigratedDatabase>, box: CryptoBox): void {
  const rows = db.query("SELECT id, scope_key, text, embedding FROM observations").all() as Array<{
    id: string;
    scope_key: string;
    text: string;
    embedding: unknown;
  }>;
  const update = db.query(
    `UPDATE observations
     SET scope_key = ?, text = '', text_enc = ?, text_idx = ?, embedding = ?
     WHERE id = ?`,
  );
  for (const row of rows) {
    const embedding = asBytes(row.embedding);
    update.run(
      Buffer.from(box.blind(row.scope_key)).toString("hex"),
      box.encrypt(utf8(row.text), aad("observations", "text", row.id)),
      box.blind(normalizeFactText(row.text)),
      embedding ? box.encrypt(embedding, aad("observations", "embedding", row.id)) : null,
      row.id,
    );
  }
}

function aliasList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((alias): alias is string => typeof alias === "string" && alias.trim() !== "");
  } catch {
    return [];
  }
}

function utf8(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}
