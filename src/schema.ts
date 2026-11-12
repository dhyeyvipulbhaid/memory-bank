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
  created_at TEXT NOT NULL
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
`;
