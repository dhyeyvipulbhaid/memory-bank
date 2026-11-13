import type { Database } from "bun:sqlite";

const EMBEDDING_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "embedding", ddl: "ALTER TABLE facts ADD COLUMN embedding BLOB" },
  { name: "embedding_model", ddl: "ALTER TABLE facts ADD COLUMN embedding_model TEXT" },
  { name: "embedding_dim", ddl: "ALTER TABLE facts ADD COLUMN embedding_dim INTEGER" },
];

/**
 * Version 1 files have no vector columns. Adding nullable columns keeps every
 * existing fact and leaves the vector null for a later backfill.
 */
export function migrateSchema(db: Database): void {
  if (schemaVersion(db) < 2) migrateEmbeddings(db);
  if (schemaVersion(db) < 3) migrateObservations(db);
  if (schemaVersion(db) < 4) migrateEncryptionColumns(db);
}

const ENCRYPTION_COLUMNS: Array<{ table: string; name: string; ddl: string }> = [
  { table: "facts", name: "text_enc", ddl: "ALTER TABLE facts ADD COLUMN text_enc BLOB" },
  { table: "facts", name: "text_idx", ddl: "ALTER TABLE facts ADD COLUMN text_idx BLOB" },
  { table: "observations", name: "text_enc", ddl: "ALTER TABLE observations ADD COLUMN text_enc BLOB" },
  { table: "observations", name: "text_idx", ddl: "ALTER TABLE observations ADD COLUMN text_idx BLOB" },
  { table: "sources", name: "text_enc", ddl: "ALTER TABLE sources ADD COLUMN text_enc BLOB" },
  { table: "sources", name: "context_enc", ddl: "ALTER TABLE sources ADD COLUMN context_enc BLOB" },
  { table: "sources", name: "speaker_enc", ddl: "ALTER TABLE sources ADD COLUMN speaker_enc BLOB" },
  { table: "source_chunks", name: "text_enc", ddl: "ALTER TABLE source_chunks ADD COLUMN text_enc BLOB" },
  { table: "entities", name: "canonical_name_enc", ddl: "ALTER TABLE entities ADD COLUMN canonical_name_enc BLOB" },
  { table: "entities", name: "aliases_enc", ddl: "ALTER TABLE entities ADD COLUMN aliases_enc BLOB" },
  { table: "entities", name: "name_idx", ddl: "ALTER TABLE entities ADD COLUMN name_idx BLOB" },
];

function migrateEncryptionColumns(db: Database): void {
  const apply = db.transaction(() => {
    for (const column of ENCRYPTION_COLUMNS) {
      const names = new Set(
        (db.query(`PRAGMA table_info(${column.table})`).all() as Array<{ name: string }>).map((row) => row.name),
      );
      if (!names.has(column.name)) db.exec(column.ddl);
    }
    db.exec(ENTITY_NAME_INDEX_SQL);
    db.query("UPDATE schema_meta SET value = '4' WHERE key = 'version'").run();
  });
  apply();
}

const ENTITY_NAME_INDEX_SQL = `
CREATE TABLE IF NOT EXISTS entity_name_index (
  bank_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  name_idx BLOB NOT NULL,
  PRIMARY KEY (bank_id, entity_id, name_idx)
);
CREATE INDEX IF NOT EXISTS idx_entity_name_lookup ON entity_name_index(bank_id, name_idx);
CREATE INDEX IF NOT EXISTS idx_facts_text_idx ON facts(bank_id, text_idx);
`;

function migrateEmbeddings(db: Database): void {
  const names = new Set(
    (db.query("PRAGMA table_info(facts)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  const apply = db.transaction(() => {
    for (const column of EMBEDDING_COLUMNS) {
      if (!names.has(column.name)) db.exec(column.ddl);
    }
    db.query("UPDATE schema_meta SET value = '2' WHERE key = 'version'").run();
  });
  apply();
}

function migrateObservations(db: Database): void {
  const apply = db.transaction(() => {
    db.exec(OBSERVATIONS_SQL);
    db.query("UPDATE schema_meta SET value = '3' WHERE key = 'version'").run();
  });
  apply();
}

const OBSERVATIONS_SQL = `
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  text TEXT NOT NULL,
  text_enc BLOB,
  text_idx BLOB,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT,
  embedding_dim INTEGER
);

CREATE INDEX IF NOT EXISTS idx_observations_scope ON observations(bank_id, scope_key);

CREATE TABLE IF NOT EXISTS observation_sources (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  bank_id TEXT NOT NULL,
  PRIMARY KEY (observation_id, fact_id)
);

CREATE INDEX IF NOT EXISTS idx_observation_sources_fact ON observation_sources(bank_id, fact_id);
`;

function schemaVersion(db: Database): number {
  const row = db.query("SELECT value FROM schema_meta WHERE key = 'version'").get() as
    | { value: string }
    | null;
  const version = Number(row?.value ?? 0);
  return Number.isFinite(version) ? version : 0;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('version', '1');

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  text TEXT NOT NULL,
  text_enc BLOB,
  context TEXT,
  context_enc BLOB,
  speaker TEXT,
  speaker_enc BLOB,
  mentioned_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sources_bank ON sources(bank_id);

CREATE TABLE IF NOT EXISTS source_chunks (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  text_enc BLOB
);

CREATE INDEX IF NOT EXISTS idx_chunks_source ON source_chunks(bank_id, source_id, ordinal);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  canonical_name_enc BLOB,
  aliases_json TEXT NOT NULL,
  aliases_enc BLOB,
  name_idx BLOB,
  type TEXT NOT NULL CHECK (type IN ('person', 'org', 'place', 'product', 'concept', 'other')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entities_bank ON entities(bank_id);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('world', 'experience')),
  occurrence_time TEXT,
  mentioned_at TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id),
  created_at TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT,
  embedding_dim INTEGER,
  text_enc BLOB,
  text_idx BLOB
);

CREATE INDEX IF NOT EXISTS idx_facts_bank ON facts(bank_id, mentioned_at);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  edge_type TEXT NOT NULL CHECK (edge_type = 'mentions'),
  fact_id TEXT NOT NULL REFERENCES facts(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  UNIQUE (bank_id, edge_type, fact_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_entity ON edges(bank_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_edges_fact ON edges(bank_id, fact_id);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  text TEXT NOT NULL,
  text_enc BLOB,
  text_idx BLOB,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT,
  embedding_dim INTEGER
);

CREATE INDEX IF NOT EXISTS idx_observations_scope ON observations(bank_id, scope_key);

CREATE TABLE IF NOT EXISTS observation_sources (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  bank_id TEXT NOT NULL,
  PRIMARY KEY (observation_id, fact_id)
);

CREATE INDEX IF NOT EXISTS idx_observation_sources_fact ON observation_sources(bank_id, fact_id);
`;
