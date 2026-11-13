import type { Database } from "bun:sqlite";
import { asEmbeddingBytes, decodeEmbedding } from "./embed.ts";
import { MemoryBankError } from "./errors.ts";
import { openBytes, openText } from "./sealed.ts";
import { eventInstant } from "./time-window.ts";
import type { FactKind, GraphEdge, GraphNode, GraphSnapshot, GraphSnapshotInput } from "./types.ts";

export const DEFAULT_GRAPH_LIMIT = 200;
export const MAX_GRAPH_LIMIT = 1000;
export const DEFAULT_MIN_SIMILARITY = 0.72;
const SEMANTIC_K = 3;
const ENTITY_DEGREE = 3;
const TEMPORAL_WINDOW_MS = 7 * 86_400_000;
const MAX_EDGES = 4000;
const LABEL_LENGTH = 80;
const HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

interface RawNode {
  id: string;
  text: string;
  kind: FactKind | "observation";
  mentionedAt: string;
  occurrenceTime: string | null;
  when: number;
  sourceFactCount: number;
  derived: boolean;
  vector: Float32Array | null;
  norm: number;
}

/**
 * A bounded slice of the bank for a force-directed view.
 * Semantic edges are top-k neighbors above the cosine cutoff.
 * Temporal edges join facts that follow each other within a week.
 * Entity edges join facts that share a mention, capped per node.
 * Derived edges point from an observation to the facts it cites.
 */
export function buildGraphSnapshot(
  db: Database,
  bankId: string,
  input: GraphSnapshotInput = {},
): GraphSnapshot {
  const limit = input.limit ?? DEFAULT_GRAPH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_GRAPH_LIMIT) {
    throw new MemoryBankError(`limit must be an integer from 1 to ${MAX_GRAPH_LIMIT}.`);
  }
  const minSimilarity = input.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
    throw new MemoryBankError("minSimilarity must be a number from 0 to 1.");
  }
  const since = input.since == null ? null : instant(input.since, "since");
  const until = input.until == null ? null : instant(input.until, "until");
  const now = input.now == null ? new Date() : input.now instanceof Date ? input.now : new Date(input.now);
  if (Number.isNaN(now.getTime())) throw new MemoryBankError(`Invalid time: ${String(input.now)}`);

  const raw = loadNodes(db, bankId, input.includeObservations !== false, since, until);
  raw.sort((left, right) => right.when - left.when || (left.id < right.id ? -1 : 1));
  const selected = raw.slice(0, limit);
  if (selected.length === 0) return { nodes: [], edges: [] };

  const present = new Set(selected.map((node) => node.id));
  const edges: GraphEdge[] = [];
  pushSemantic(selected, minSimilarity, edges);
  pushTemporal(selected, edges);
  pushEntity(db, bankId, selected, edges);
  pushDerived(db, bankId, selected, present, edges);

  const capped = edges.slice(0, MAX_EDGES);
  const nodes: GraphNode[] = selected.map((node) => ({
    id: node.id,
    label: truncate(node.text),
    kind: node.kind,
    mentionedAt: node.mentionedAt,
    occurrenceTime: node.occurrenceTime,
    sourceFactCount: node.sourceFactCount,
    recency: recency(node.when, now),
    derived: node.derived,
  }));
  return { nodes, edges: capped };
}

function loadNodes(
  db: Database,
  bankId: string,
  includeObservations: boolean,
  since: number | null,
  until: number | null,
): RawNode[] {
  const facts = db
    .query(
      `SELECT id, text, text_enc, kind, occurrence_time, mentioned_at, embedding, embedding_dim
       FROM facts
       WHERE bank_id = ?`,
    )
    .all(bankId) as Array<{
    id: string;
    text: string;
    text_enc: unknown;
    kind: string;
    occurrence_time: string | null;
    mentioned_at: string;
    embedding: unknown;
    embedding_dim: number | null;
  }>;
  const nodes: RawNode[] = [];
  for (const fact of facts) {
    const when = eventInstant(fact.occurrence_time, fact.mentioned_at);
    if (when == null || !inRange(when, since, until)) continue;
    const vector = vectorOf(db, "facts", fact.id, fact.embedding, fact.embedding_dim);
    nodes.push({
      id: fact.id,
      text: openText(db, "facts", "text", fact.id, fact.text, fact.text_enc, true) ?? "",
      kind: fact.kind as FactKind,
      mentionedAt: fact.mentioned_at,
      occurrenceTime: fact.occurrence_time,
      when,
      sourceFactCount: 1,
      derived: false,
      vector,
      norm: normOf(vector),
    });
  }
  if (!includeObservations) return nodes;

  const observations = db
    .query(
      `SELECT id, text, text_enc, updated_at, embedding, embedding_dim
       FROM observations
       WHERE bank_id = ?`,
    )
    .all(bankId) as Array<{
    id: string;
    text: string;
    text_enc: unknown;
    updated_at: string;
    embedding: unknown;
    embedding_dim: number | null;
  }>;
  const counts = citationCounts(db, bankId);
  for (const observation of observations) {
    const when = Date.parse(observation.updated_at);
    if (Number.isNaN(when) || !inRange(when, since, until)) continue;
    const vector = vectorOf(db, "observations", observation.id, observation.embedding, observation.embedding_dim);
    nodes.push({
      id: observation.id,
      text: openText(db, "observations", "text", observation.id, observation.text, observation.text_enc, true) ?? "",
      kind: "observation",
      mentionedAt: observation.updated_at,
      occurrenceTime: null,
      when,
      sourceFactCount: counts.get(observation.id) ?? 0,
      derived: true,
      vector,
      norm: normOf(vector),
    });
  }
  return nodes;
}

function pushSemantic(nodes: RawNode[], minSimilarity: number, edges: GraphEdge[]): void {
  const indexed = nodes.filter((node) => node.vector && node.norm > 0);
  const seen = new Set<string>();
  for (const origin of indexed) {
    const left = origin.vector;
    if (!left) continue;
    const scored: Array<{ id: string; weight: number }> = [];
    for (const other of indexed) {
      if (other.id === origin.id) continue;
      const right = other.vector;
      if (!right || left.length !== right.length) continue;
      const weight = dot(left, right) / (origin.norm * other.norm);
      if (weight >= minSimilarity) scored.push({ id: other.id, weight });
    }
    scored.sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1));
    for (const hit of scored.slice(0, SEMANTIC_K)) {
      const edge = undirected(origin.id, hit.id, "semantic", hit.weight);
      const key = `${edge.source}\0${edge.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (edges.length >= MAX_EDGES) return;
      edges.push(edge);
    }
  }
}

function pushTemporal(nodes: RawNode[], edges: GraphEdge[]): void {
  const ordered = [...nodes].sort((left, right) => left.when - right.when || (left.id < right.id ? -1 : 1));
  for (let index = 0; index < ordered.length - 1; index++) {
    const left = ordered[index];
    const right = ordered[index + 1];
    if (!left || !right) continue;
    const gap = right.when - left.when;
    if (gap < 0 || gap > TEMPORAL_WINDOW_MS) continue;
    if (edges.length >= MAX_EDGES) return;
    const weight = 1 - gap / TEMPORAL_WINDOW_MS;
    edges.push(undirected(left.id, right.id, "temporal", weight));
  }
}

function pushEntity(db: Database, bankId: string, nodes: RawNode[], edges: GraphEdge[]): void {
  const ids = nodes.filter((node) => !node.derived).map((node) => node.id);
  if (ids.length === 0) return;
  const marks = ids.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT fact_id, entity_id
       FROM edges
       WHERE bank_id = ? AND edge_type = 'mentions' AND fact_id IN (${marks})`,
    )
    .all(bankId, ...ids) as Array<{ fact_id: string; entity_id: string }>;
  const byEntity = new Map<string, string[]>();
  for (const row of rows) {
    const list = byEntity.get(row.entity_id) ?? [];
    list.push(row.fact_id);
    byEntity.set(row.entity_id, list);
  }
  const when = new Map(nodes.map((node) => [node.id, node.when]));
  const shared = new Map<string, { source: string; target: string; weight: number }>();
  for (const members of byEntity.values()) {
    const unique = [...new Set(members)].sort(
      (left, right) => (when.get(left) ?? 0) - (when.get(right) ?? 0) || (left < right ? -1 : 1),
    );
    for (let index = 0; index < unique.length; index++) {
      const origin = unique[index];
      if (!origin) continue;
      for (let step = 1; step <= ENTITY_DEGREE && index + step < unique.length; step++) {
        const other = unique[index + step];
        if (!other) continue;
        const [source, target] = origin < other ? [origin, other] : [other, origin];
        const key = `${source}\0${target}`;
        const current = shared.get(key);
        if (current) current.weight += 1;
        else shared.set(key, { source, target, weight: 1 });
      }
    }
  }
  for (const edge of shared.values()) {
    if (edges.length >= MAX_EDGES) return;
    edges.push({ source: edge.source, target: edge.target, type: "entity", weight: edge.weight });
  }
}

function pushDerived(
  db: Database,
  bankId: string,
  nodes: RawNode[],
  present: Set<string>,
  edges: GraphEdge[],
): void {
  const observations = nodes.filter((node) => node.derived).map((node) => node.id);
  if (observations.length === 0) return;
  const marks = observations.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT observation_id, fact_id
       FROM observation_sources
       WHERE bank_id = ? AND observation_id IN (${marks})`,
    )
    .all(bankId, ...observations) as Array<{ observation_id: string; fact_id: string }>;
  for (const row of rows) {
    if (!present.has(row.fact_id)) continue;
    if (edges.length >= MAX_EDGES) return;
    edges.push({ source: row.observation_id, target: row.fact_id, type: "derived", weight: 1 });
  }
}

function undirected(
  left: string,
  right: string,
  type: GraphEdge["type"],
  weight: number,
): GraphEdge {
  const [source, target] = left < right ? [left, right] : [right, left];
  return { source, target, type, weight };
}

function vectorOf(db: Database, table: string, id: string, blob: unknown, dim: number | null): Float32Array | null {
  const bytes = asEmbeddingBytes(openBytes(db, table, "embedding", id, blob));
  if (!bytes || dim == null) return null;
  return decodeEmbedding(bytes, dim);
}

function normOf(vector: Float32Array | null): number {
  if (!vector) return 0;
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function dot(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) sum += (left[index] ?? 0) * (right[index] ?? 0);
  return sum;
}

function citationCounts(db: Database, bankId: string): Map<string, number> {
  const rows = db
    .query(
      `SELECT observation_id AS id, COUNT(*) AS n
       FROM observation_sources
       WHERE bank_id = ?
       GROUP BY observation_id`,
    )
    .all(bankId) as Array<{ id: string; n: number | bigint }>;
  return new Map(rows.map((row) => [row.id, Number(row.n)]));
}

function inRange(when: number, since: number | null, until: number | null): boolean {
  if (since != null && when < since) return false;
  if (until != null && when >= until) return false;
  return true;
}

function instant(value: string | Date, label: string): number {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new MemoryBankError(`Invalid time: ${label}`);
  return date.getTime();
}

function recency(when: number, now: Date): number {
  const ageDays = (now.getTime() - when) / DAY_MS;
  if (ageDays <= 0) return 1;
  return Math.max(0, Math.min(1, 0.5 ** (ageDays / HALF_LIFE_DAYS)));
}

function truncate(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= LABEL_LENGTH) return trimmed;
  return `${trimmed.slice(0, LABEL_LENGTH - 1)}…`;
}
