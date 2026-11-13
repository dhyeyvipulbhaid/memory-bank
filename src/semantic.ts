import type { Database } from "bun:sqlite";
import { asEmbeddingBytes, decodeEmbedding } from "./embed.ts";
import { MemoryBankError } from "./errors.ts";
import { assertEntityType } from "./resolve.ts";
import { isSealed, openBytes, openText } from "./sealed.ts";
import { estimateTokens } from "./tokens.ts";
import type { FactKind, RecalledFact, RecallResult, VectorPoint, VectorRanker } from "./types.ts";

interface VectorFactRow {
  id: string;
  text: string;
  kind: string;
  occurrence_time: string | null;
  mentioned_at: string;
  source_id: string;
  embedding: unknown;
  embedding_dim: number;
}

interface LinkRow {
  fact_id: string;
  id: string;
  name: string;
  type: string;
}

/**
 * Rank facts that already have a vector for this model and dimension.
 * Packing matches recall: a fact that does not fit the remaining budget is skipped.
 */
export function searchByVector(
  db: Database,
  bankId: string,
  query: Float32Array,
  model: string,
  tokenBudget: number,
  limit: number,
  ranker: VectorRanker,
): RecallResult {
  if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
    throw new MemoryBankError("tokenBudget must be a finite number of zero or more.");
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new MemoryBankError("limit must be an integer of zero or more.");
  }
  if (tokenBudget === 0 || limit === 0 || query.length === 0) {
    return { facts: [], tokensUsed: 0 };
  }

  const rows = db
    .query(
      `SELECT id, text, text_enc, kind, occurrence_time, mentioned_at, source_id, embedding, embedding_dim
       FROM facts
       WHERE bank_id = ?
         AND embedding IS NOT NULL
         AND embedding_model = ?
         AND embedding_dim = ?`,
    )
    .all(bankId, model, query.length) as VectorFactRow[];

  const points: VectorPoint[] = [];
  const byId = new Map<string, VectorFactRow>();
  for (const row of rows) {
    const bytes = asEmbeddingBytes(openBytes(db, "facts", "embedding", row.id, row.embedding));
    if (!bytes) continue;
    const vector = decodeEmbedding(bytes, row.embedding_dim);
    if (!vector) continue;
    points.push({ id: row.id, vector });
    byId.set(row.id, row);
  }
  if (points.length === 0) return { facts: [], tokensUsed: 0 };

  const hits = ranker.rank(query, points);
  const links = loadLinks(
    db,
    bankId,
    hits.map((hit) => hit.id),
  );
  const ranked: RecalledFact[] = [];
  for (const hit of hits) {
    const fact = byId.get(hit.id);
    if (!fact || hit.score <= 0) continue;
    ranked.push({
      id: fact.id,
      text: openText(db, "facts", "text", fact.id, fact.text, (fact as VectorFactRow & { text_enc?: unknown }).text_enc, true) ?? "",
      kind: fact.kind as FactKind,
      occurrenceTime: fact.occurrence_time,
      mentionedAt: fact.mentioned_at,
      sourceId: fact.source_id,
      entities: links.get(fact.id) ?? [],
      score: hit.score,
    });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.mentionedAt !== right.mentionedAt) return left.mentionedAt < right.mentionedAt ? 1 : -1;
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    return 0;
  });

  const selected: RecalledFact[] = [];
  let tokensUsed = 0;
  for (const fact of ranked) {
    if (selected.length >= limit) break;
    const cost = estimateTokens(fact.text);
    if (cost > tokenBudget || tokensUsed + cost > tokenBudget) continue;
    selected.push(fact);
    tokensUsed += cost;
  }
  return { facts: selected, tokensUsed };
}

function loadLinks(
  db: Database,
  bankId: string,
  factIds: string[],
): Map<string, RecalledFact["entities"]> {
  const links = new Map<string, RecalledFact["entities"]>();
  if (factIds.length === 0) return links;
  const rows: LinkRow[] = [];
  for (let offset = 0; offset < factIds.length; offset += 200) {
    const slice = factIds.slice(offset, offset + 200);
    const marks = slice.map(() => "?").join(", ");
    const found = db
      .query(
        `SELECT g.fact_id AS fact_id, e.id AS id, e.canonical_name AS name,
                e.canonical_name_enc AS name_enc, e.type AS type
         FROM edges g
         JOIN entities e ON e.id = g.entity_id AND e.bank_id = g.bank_id
         WHERE g.bank_id = ? AND g.edge_type = 'mentions' AND g.fact_id IN (${marks})
         ORDER BY e.canonical_name, e.id`,
      )
      .all(bankId, ...slice) as Array<LinkRow & { name_enc: unknown }>;
    rows.push(...found);
  }
  for (const row of rows) {
    const list = links.get(row.fact_id) ?? [];
    const stored = row as LinkRow & { name_enc?: unknown };
    list.push({
      id: stored.id,
      name: openText(db, "entities", "canonical_name", stored.id, stored.name, stored.name_enc, true) ?? "",
      type: assertEntityType(stored.type),
    });
    links.set(row.fact_id, list);
  }
  if (isSealed(db)) {
    for (const list of links.values()) {
      list.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : left.id < right.id ? -1 : 1));
    }
  }
  return links;
}
