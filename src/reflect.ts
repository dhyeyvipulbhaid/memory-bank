import type { Database } from "bun:sqlite";
import { normalizeFactText } from "./dedupe.ts";
import { ReflectFailedError } from "./errors.ts";
import { isAssistantKnowledgeGap } from "./knowledge-gap.ts";
import type { ObservationDraft, ObservationRecord } from "./types.ts";

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
): ObservationDraft[] {
  const accepted: ObservationDraft[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    if (accepted.length >= maxObservations) break;
    const text = draft.text.trim();
    const key = normalizeFactText(text);
    if (!key || seen.has(key)) continue;
    if (isAssistantKnowledgeGap(text)) continue;
    if (!Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) continue;
    const sourceFactIds = [...new Set(draft.sourceFactIds)];
    if (sourceFactIds.length === 0) continue;
    if (sourceFactIds.some((id) => !allowedIds.has(id))) continue;
    seen.add(key);
    accepted.push({ text, confidence: draft.confidence, sourceFactIds });
  }
  if (accepted.length === 0) {
    throw new ReflectFailedError(
      "Reflector returned no observation that cites the gathered facts. Nothing was written.",
    );
  }
  return accepted;
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
