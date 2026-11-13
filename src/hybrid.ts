import type { Database } from "bun:sqlite";
import { asEmbeddingBytes, decodeEmbedding } from "./embed.ts";
import { MemoryBankError } from "./errors.ts";
import { normalizeName } from "./names.ts";
import { assertEntityType } from "./resolve.ts";
import { estimateTokens, meaningfulTokens, tokenize } from "./tokens.ts";
import { eventInstant, inTimeWindow, parseTimeWindow } from "./time-window.ts";
import type {
  FactKind,
  HybridFact,
  HybridRecallResult,
  HybridWeights,
  VectorPoint,
  VectorRanker,
} from "./types.ts";

export const DEFAULT_RRF_K = 60;
export const DEFAULT_HALF_LIFE_DAYS = 30;
export const DEFAULT_HYBRID_WEIGHTS: Required<HybridWeights> = {
  keyword: 1,
  vector: 1,
  graph: 1,
};

/** Small enough that one real list hit outranks a time-only fact at the same recency. */
const TIME_PRIOR = 1 / (DEFAULT_RRF_K + 1000);
const DAY_MS = 86_400_000;

export interface HybridRankOptions {
  query: string;
  tokenBudget: number;
  limit?: number;
  weights: Required<HybridWeights>;
  rrfK: number;
  halfLifeDays: number;
  now: Date;
  queryVector: Float32Array | null;
  vectorModel: string | null;
  ranker: VectorRanker;
}

interface FactRow {
  id: string;
  text: string;
  kind: string;
  occurrence_time: string | null;
  mentioned_at: string;
  source_id: string;
  embedding: unknown;
  embedding_model: string | null;
  embedding_dim: number | null;
}

interface LinkRow {
  fact_id: string;
  id: string;
  name: string;
  type: string;
  aliases_json: string;
}

/**
 * Fuse keyword, vector, and graph lists with reciprocal rank fusion, then
 * rerank by recency. A time cue drops facts outside that window and gives
 * facts inside it a small prior so the window can surface on its own.
 */
export function rankHybridFacts(db: Database, bankId: string, options: HybridRankOptions): HybridFact[] {
  if (!Number.isFinite(options.tokenBudget) || options.tokenBudget < 0) {
    throw new MemoryBankError("tokenBudget must be a finite number of zero or more.");
  }
  if (options.limit != null && (!Number.isInteger(options.limit) || options.limit < 0)) {
    throw new MemoryBankError("limit must be an integer of zero or more.");
  }
  if (options.tokenBudget === 0 || options.limit === 0 || options.query.trim() === "") {
    return [];
  }

  const facts = db
    .query(
      `SELECT id, text, kind, occurrence_time, mentioned_at, source_id,
              embedding, embedding_model, embedding_dim
       FROM facts
       WHERE bank_id = ?`,
    )
    .all(bankId) as FactRow[];
  if (facts.length === 0) return [];

  const links = loadLinks(db, bankId);
  const tokens = meaningfulTokens(options.query);
  const window = parseTimeWindow(options.query, options.now);

  const keywordIds = rankIds(keywordScores(facts, tokens));
  const vectorIds = rankIds(vectorScores(facts, options));
  const graphIds = rankIds(graphScores(facts, links, options.query, tokens));

  const parts = fuseParts(
    [
      { ids: keywordIds, weight: options.weights.keyword, key: "keyword" as const },
      { ids: vectorIds, weight: options.weights.vector, key: "vector" as const },
      { ids: graphIds, weight: options.weights.graph, key: "graph" as const },
    ],
    options.rrfK,
  );

  const ranked: HybridFact[] = [];
  for (const fact of facts) {
    const when = eventInstant(fact.occurrence_time, fact.mentioned_at);
    if (window && (when == null || !inTimeWindow(when, window))) continue;
    const part = parts.get(fact.id) ?? { keyword: 0, vector: 0, graph: 0 };
    const fusion = part.keyword + part.vector + part.graph;
    const prior = window ? TIME_PRIOR : 0;
    if (fusion + prior <= 0) continue;
    const recency = recencyFactor(when, options.now, options.halfLifeDays);
    const entities = (links.get(fact.id) ?? []).map((link) => ({
      id: link.id,
      name: link.name,
      type: assertEntityType(link.type),
    }));
    entities.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    ranked.push({
      id: fact.id,
      text: fact.text,
      kind: fact.kind as FactKind,
      occurrenceTime: fact.occurrence_time,
      mentionedAt: fact.mentioned_at,
      sourceId: fact.source_id,
      entities,
      score: (fusion + prior) * recency,
      breakdown: {
        keyword: part.keyword,
        vector: part.vector,
        graph: part.graph,
        recency,
      },
    });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.mentionedAt !== right.mentionedAt) return left.mentionedAt < right.mentionedAt ? 1 : -1;
    return left.id < right.id ? -1 : 1;
  });
  return ranked;
}

export function packHybridFacts(
  facts: readonly HybridFact[],
  tokenBudget: number,
  limit?: number,
): HybridRecallResult {
  const selected: HybridFact[] = [];
  let tokensUsed = 0;
  for (const fact of facts) {
    if (limit != null && selected.length >= limit) break;
    const cost = estimateTokens(fact.text);
    if (cost > tokenBudget || tokensUsed + cost > tokenBudget) continue;
    selected.push(fact);
    tokensUsed += cost;
  }
  return { facts: selected, tokensUsed };
}

function keywordScores(facts: readonly FactRow[], tokens: readonly string[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (tokens.length === 0) return scores;
  for (const fact of facts) {
    const factTokens = new Set(tokenize(fact.text));
    let score = 0;
    for (const token of tokens) {
      if (factTokens.has(token)) score += 1;
    }
    if (score > 0) scores.set(fact.id, score);
  }
  return scores;
}

function vectorScores(facts: readonly FactRow[], options: HybridRankOptions): Map<string, number> {
  const scores = new Map<string, number>();
  const query = options.queryVector;
  if (!query || !options.vectorModel || query.length === 0) return scores;
  const points: VectorPoint[] = [];
  for (const fact of facts) {
    if (fact.embedding_model !== options.vectorModel || fact.embedding_dim !== query.length) continue;
    const bytes = asEmbeddingBytes(fact.embedding);
    if (!bytes) continue;
    const vector = decodeEmbedding(bytes, fact.embedding_dim);
    if (!vector) continue;
    points.push({ id: fact.id, vector });
  }
  if (points.length === 0) return scores;
  for (const hit of options.ranker.rank(query, points)) {
    if (hit.score > 0) scores.set(hit.id, hit.score);
  }
  return scores;
}

function graphScores(
  facts: readonly FactRow[],
  links: Map<string, LinkRow[]>,
  query: string,
  tokens: readonly string[],
): Map<string, number> {
  const scores = new Map<string, number>();
  const queryNorm = normalizeName(query);
  const queryTokens = new Set(tokens);
  const entityScore = new Map<string, number>();
  const seenEntities = new Set<string>();
  for (const fact of facts) {
    for (const link of links.get(fact.id) ?? []) {
      if (seenEntities.has(link.id)) continue;
      seenEntities.add(link.id);
      const best = scoreEntityName(link.name, link.aliases_json, queryNorm, queryTokens);
      if (best > 0) entityScore.set(link.id, best);
    }
  }
  if (entityScore.size === 0) return scores;

  const factsByEntity = new Map<string, string[]>();
  for (const fact of facts) {
    for (const link of links.get(fact.id) ?? []) {
      const list = factsByEntity.get(link.id) ?? [];
      list.push(fact.id);
      factsByEntity.set(link.id, list);
    }
  }

  const directEntities = new Set<string>();
  for (const [entityId, weight] of entityScore) {
    directEntities.add(entityId);
    for (const factId of factsByEntity.get(entityId) ?? []) {
      scores.set(factId, (scores.get(factId) ?? 0) + weight);
    }
  }

  const neighbors = new Set<string>();
  for (const fact of facts) {
    if (!scores.has(fact.id)) continue;
    for (const link of links.get(fact.id) ?? []) {
      if (!directEntities.has(link.id)) neighbors.add(link.id);
    }
  }
  for (const entityId of neighbors) {
    for (const factId of factsByEntity.get(entityId) ?? []) {
      if (!scores.has(factId)) scores.set(factId, 1);
    }
  }
  return scores;
}

function scoreEntityName(
  canonical: string,
  aliasesJson: string,
  queryNorm: string,
  queryTokens: Set<string>,
): number {
  const padded = ` ${queryNorm} `;
  let best = 0;
  for (const name of [canonical, ...parseAliases(aliasesJson)]) {
    const norm = normalizeName(name);
    if (!norm) continue;
    const parts = norm.split(" ");
    if (padded.includes(` ${norm} `)) {
      best = Math.max(best, 10 + parts.length * 3);
      continue;
    }
    const overlap = parts.filter((part) => part.length >= 3 && queryTokens.has(part));
    if (overlap.length === parts.length) best = Math.max(best, 5 + parts.length * 2);
    else if (overlap.length > 0) best = Math.max(best, overlap.length * 2);
  }
  return best;
}

function fuseParts(
  lists: Array<{ ids: string[]; weight: number; key: "keyword" | "vector" | "graph" }>,
  k: number,
): Map<string, { keyword: number; vector: number; graph: number }> {
  const parts = new Map<string, { keyword: number; vector: number; graph: number }>();
  for (const list of lists) {
    if (list.weight === 0) continue;
    list.ids.forEach((id, index) => {
      const current = parts.get(id) ?? { keyword: 0, vector: 0, graph: 0 };
      current[list.key] = list.weight / (k + index + 1);
      parts.set(id, current);
    });
  }
  return parts;
}

function rankIds(scores: Map<string, number>): string[] {
  return [...scores.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
    })
    .map(([id]) => id);
}

function recencyFactor(when: number | null, now: Date, halfLifeDays: number): number {
  if (when == null) return 0;
  const ageDays = (now.getTime() - when) / DAY_MS;
  if (ageDays <= 0) return 1;
  return 0.5 ** (ageDays / halfLifeDays);
}

function loadLinks(db: Database, bankId: string): Map<string, LinkRow[]> {
  const rows = db
    .query(
      `SELECT g.fact_id AS fact_id, e.id AS id, e.canonical_name AS name, e.type AS type,
              e.aliases_json AS aliases_json
       FROM edges g
       JOIN entities e ON e.id = g.entity_id AND e.bank_id = g.bank_id
       WHERE g.bank_id = ? AND g.edge_type = 'mentions'
       ORDER BY e.canonical_name`,
    )
    .all(bankId) as LinkRow[];
  const links = new Map<string, LinkRow[]>();
  for (const row of rows) {
    const list = links.get(row.fact_id) ?? [];
    list.push(row);
    links.set(row.fact_id, list);
  }
  return links;
}

function parseAliases(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((alias): alias is string => typeof alias === "string");
  } catch {
    return [];
  }
}
