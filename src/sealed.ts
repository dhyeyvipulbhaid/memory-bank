import type { Database } from "bun:sqlite";
import { aad, type CryptoBox } from "./crypto.ts";
import { EncryptionError } from "./errors.ts";
import { normalizeName } from "./names.ts";

const boxes = new WeakMap<Database, CryptoBox>();

export function attachBox(db: Database, box: CryptoBox): void {
  boxes.set(db, box);
}

export function cryptoBox(db: Database): CryptoBox | null {
  return boxes.get(db) ?? null;
}

export function isSealed(db: Database): boolean {
  return boxes.has(db);
}

export function asBytes(value: unknown): Uint8Array | null {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  return null;
}

/** Store a string. Encrypted banks keep ciphertext in `enc` and a blind index, not the plaintext. */
export function sealText(
  db: Database,
  table: string,
  column: string,
  id: string,
  value: string | null,
  blindOf?: string,
): { text: string | null; enc: Uint8Array | null; index: Uint8Array | null } {
  const box = cryptoBox(db);
  if (value == null) return { text: null, enc: null, index: null };
  if (!box) return { text: value, enc: null, index: null };
  return {
    text: "",
    enc: box.encrypt(Buffer.from(value, "utf8"), aad(table, column, id)),
    index: blindOf == null ? null : box.blind(blindOf),
  };
}

export function openText(
  db: Database,
  table: string,
  column: string,
  id: string,
  text: string | null,
  enc: unknown,
  required = false,
): string | null {
  const box = cryptoBox(db);
  if (!box) return text;
  const bytes = asBytes(enc);
  if (!bytes) {
    if (required) throw new EncryptionError(`Missing ciphertext for ${table}.${column}.`);
    return null;
  }
  return Buffer.from(box.decrypt(bytes, aad(table, column, id))).toString("utf8");
}

/** Plaintext column value to store beside ciphertext. Nullable columns stay null. */
export function storedPlain(db: Database, value: string | null, notNull: boolean): string | null {
  if (!isSealed(db)) return value;
  if (value == null) return null;
  return notNull ? "" : null;
}

export function sealBytes(
  db: Database,
  table: string,
  column: string,
  id: string,
  value: Uint8Array | null,
): Uint8Array | null {
  const box = cryptoBox(db);
  if (!value) return null;
  if (!box) return value;
  return box.encrypt(value, aad(table, column, id));
}

export function openBytes(
  db: Database,
  table: string,
  column: string,
  id: string,
  value: unknown,
): Uint8Array | null {
  const bytes = asBytes(value);
  if (!bytes) return null;
  const box = cryptoBox(db);
  if (!box) return bytes;
  return box.decrypt(bytes, aad(table, column, id));
}

export function blindIndex(db: Database, normalized: string): Uint8Array | null {
  const box = cryptoBox(db);
  if (!box || !normalized) return null;
  return box.blind(normalized);
}

/** Scope equality key. Encrypted banks store an HMAC, not the query text. */
export function storedScope(db: Database, scope: string): string {
  const box = cryptoBox(db);
  if (!box) return scope;
  return Buffer.from(box.blind(scope)).toString("hex");
}

export function syncNameIndex(
  db: Database,
  bankId: string,
  entityId: string,
  canonical: string,
  aliases: readonly string[],
): void {
  db.query("DELETE FROM entity_name_index WHERE bank_id = ? AND entity_id = ?").run(bankId, entityId);
  const box = cryptoBox(db);
  if (!box) return;
  const insert = db.query(
    "INSERT OR IGNORE INTO entity_name_index (bank_id, entity_id, name_idx) VALUES (?, ?, ?)",
  );
  for (const name of [canonical, ...aliases]) {
    const normalized = normalizeName(name);
    if (!normalized) continue;
    insert.run(bankId, entityId, box.blind(normalized));
  }
}

export function exactEntityIds(db: Database, bankId: string, name: string): string[] {
  const index = blindIndex(db, normalizeName(name));
  if (!index) return [];
  const rows = db
    .query("SELECT entity_id FROM entity_name_index WHERE bank_id = ? AND name_idx = ?")
    .all(bankId, index) as Array<{ entity_id: string }>;
  return rows.map((row) => row.entity_id);
}
