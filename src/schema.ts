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
}

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
  context TEXT,
  speaker TEXT,
  mentioned_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sources_bank ON sources(bank_id);

CREATE TABLE IF NOT EXISTS source_chunks (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_source ON source_chunks(bank_id, source_id, ordinal);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
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
  embedding_dim INTEGER
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
