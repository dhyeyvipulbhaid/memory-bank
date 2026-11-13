import type { Database } from "bun:sqlite";
import { normalizeFactText } from "./dedupe.ts";
import { ReflectFailedError } from "./errors.ts";
import { isAssistantKnowledgeGap } from "./knowledge-gap.ts";
import { meaningfulTokens } from "./tokens.ts";
import type { ObservationDraft, ObservationRecord } from "./types.ts";

/** Token overlap above this is the same observation said twice. */
const TEXT_SIMILARITY = 0.55;
/** Embedding cosine at or above this is the same observation. */
const VECTOR_SIMILARITY = 0.85;

const SPECULATIVE =
  /\b(?:suggest(?:s|ed|ing)?|indicat(?:e|es|ed|ing)|seem(?:s|ed|ing)?|appear(?:s|ed|ing)?|might|may|possibly|probably|likely|perhaps|could)\b/i;
const META =
  /\b(?:separate from|separately from|mentioned in the context|in the context of|unrelated to|distinct from|as opposed to|not related to)\b/i;

export const MAX_OBSERVATIONS = 5;

export interface StoredObservationVector {
  model: string;
  dim: number;
  bytes: Uint8Array;
}

interface ObservationRow {
  id: string;
  text: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

/**
 * Drop drafts that cite nothing, cite a fact outside the input, fail the junk
 * filter, or have no text. Throws when none remain so the caller writes nothing.
 */
export function acceptObservations(
  drafts: readonly ObservationDraft[],
  allowedIds: ReadonlySet<string>,
  maxObservations: number,
  options: { singleEntity?: boolean; vectors?: ReadonlyMap<string, readonly number[]> } = {},
): ObservationDraft[] {
  const requireTwo = options.singleEntity !== true && allowedIds.size >= 2;
  const accepted: ObservationDraft[] = [];
  for (const draft of drafts) {
    const text = draft.text.trim();
    const key = normalizeFactText(text);
    if (!key) continue;
    if (isAssistantKnowledgeGap(text) || isLowValueObservation(text)) continue;
    if (!Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) continue;
    const sourceFactIds = [...new Set(draft.sourceFactIds)];
    if (sourceFactIds.length === 0) continue;
    if (sourceFactIds.some((id) => !allowedIds.has(id))) continue;
    if (requireTwo && sourceFactIds.length < 2) continue;
    accepted.push({ text, confidence: draft.confidence, sourceFactIds });
  }
  const unique = dropNearDuplicates(accepted, options.vectors);
  if (unique.length === 0) {
    throw new ReflectFailedError(
      "Reflector returned no observation that cites the gathered facts. Nothing was written.",
    );
  }
  return unique.slice(0, maxObservations);
}

/** Meta comments and hedged guesses are not observations. */
export function isLowValueObservation(text: string): boolean {
  return SPECULATIVE.test(text) || META.test(text);
}

function dropNearDuplicates(
  drafts: readonly ObservationDraft[],
  vectors: ReadonlyMap<string, readonly number[]> | undefined,
): ObservationDraft[] {
  const ranked = [...drafts].sort((left, right) => right.confidence - left.confidence);
  const kept: ObservationDraft[] = [];
  for (const draft of ranked) {
    const duplicate = kept.some((prior) => sameObservation(prior, draft, vectors));
    if (!duplicate) kept.push(draft);
  }
  return kept;
}

function sameObservation(
  left: ObservationDraft,
  right: ObservationDraft,
  vectors: ReadonlyMap<string, readonly number[]> | undefined,
): boolean {
  if (normalizeFactText(left.text) === normalizeFactText(right.text)) return true;
  if (tokenSimilarity(left.text, right.text) >= TEXT_SIMILARITY) return true;
  const leftVector = vectors?.get(normalizeFactText(left.text));
  const rightVector = vectors?.get(normalizeFactText(right.text));
  if (leftVector && rightVector && cosine(leftVector, rightVector) >= VECTOR_SIMILARITY) return true;
  return false;
}

function tokenSimilarity(left: string, right: string): number {
  const a = new Set(meaningfulTokens(left));
  const b = new Set(meaningfulTokens(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const magnitude = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (magnitude === 0) return 0;
  return dot / magnitude;
}

export function scopeKey(parts: {
  query?: string;
  entity?: string;
  topic?: string;
  since?: string;
  until?: string;
}): string {
  return [parts.entity, parts.topic, parts.query, parts.since, parts.until]
    .map((part) => (part ?? "").trim().toLowerCase())
    .join("\n");
}

export function saveObservations(
  db: Database,
  bankId: string,
  scope: string,
  drafts: readonly ObservationDraft[],
  vectors: ReadonlyMap<string, StoredObservationVector | null>,
  now: string,
): { observations: ObservationRecord[]; removedIds: string[] } {
  const existing = db
    .query(
      `SELECT id, text, confidence, created_at, updated_at
       FROM observations
       WHERE bank_id = ? AND scope_key = ?`,
    )
    .all(bankId, scope) as ObservationRow[];
  const byText = new Map(existing.map((row) => [normalizeFactText(row.text), row]));
  const kept = new Set<string>();
  const observations: ObservationRecord[] = [];

  const insert = db.query(
    `INSERT INTO observations (
       id, bank_id, scope_key, text, confidence, created_at, updated_at,
       embedding, embedding_model, embedding_dim
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.query(
    `UPDATE observations
     SET text = ?, confidence = ?, updated_at = ?,
         embedding = ?, embedding_model = ?, embedding_dim = ?
     WHERE id = ? AND bank_id = ?`,
  );
  const clearSources = db.query(
    "DELETE FROM observation_sources WHERE observation_id = ? AND bank_id = ?",
  );
  const addSource = db.query(
    `INSERT INTO observation_sources (observation_id, fact_id, bank_id) VALUES (?, ?, ?)`,
  );

  const write = db.transaction(() => {
    for (const draft of drafts) {
      const vector = vectors.get(normalizeFactText(draft.text)) ?? null;
      const prior = byText.get(normalizeFactText(draft.text));
      const id = prior?.id ?? crypto.randomUUID();
      const createdAt = prior?.created_at ?? now;
      if (prior) {
        update.run(
          draft.text,
          draft.confidence,
          now,
          vector?.bytes ?? null,
          vector?.model ?? null,
          vector?.dim ?? null,
          id,
          bankId,
        );
      } else {
        insert.run(
          id,
          bankId,
          scope,
          draft.text,
          draft.confidence,
          createdAt,
          now,
          vector?.bytes ?? null,
          vector?.model ?? null,
          vector?.dim ?? null,
        );
      }
      clearSources.run(id, bankId);
      for (const factId of draft.sourceFactIds) addSource.run(id, factId, bankId);
      kept.add(id);
      observations.push({
        id,
        text: draft.text,
        confidence: draft.confidence,
        derived: true,
        sourceFactIds: [...draft.sourceFactIds],
        createdAt,
        updatedAt: now,
      });
    }

    const removedIds: string[] = [];
    const remove = db.query("DELETE FROM observations WHERE id = ? AND bank_id = ?");
    for (const row of existing) {
      if (kept.has(row.id)) continue;
      remove.run(row.id, bankId);
      removedIds.push(row.id);
    }
    return { observations, removedIds };
  });
  return write();
}

/** Drop citation rows whose fact is gone, then drop observations with no citations left. */
export function pruneOrphanObservations(db: Database, bankId?: string): string[] {
  const sourceSql = bankId
    ? `DELETE FROM observation_sources
       WHERE bank_id = ?
         AND fact_id NOT IN (SELECT id FROM facts WHERE bank_id = observation_sources.bank_id)`
    : `DELETE FROM observation_sources
       WHERE fact_id NOT IN (SELECT id FROM facts WHERE bank_id = observation_sources.bank_id)`;
  const doomedSql = bankId
    ? `SELECT id FROM observations
       WHERE bank_id = ?
         AND id NOT IN (SELECT observation_id FROM observation_sources WHERE bank_id = observations.bank_id)`
    : `SELECT id FROM observations
       WHERE id NOT IN (SELECT observation_id FROM observation_sources WHERE bank_id = observations.bank_id)`;
  const params = bankId ? [bankId] : [];
  const run = db.transaction(() => {
    db.query(sourceSql).run(...params);
    const doomed = db.query(doomedSql).all(...params) as Array<{ id: string }>;
    const remove = db.query("DELETE FROM observations WHERE id = ?");
    for (const row of doomed) remove.run(row.id);
    return doomed.map((row) => row.id);
  });
  return run();
}
