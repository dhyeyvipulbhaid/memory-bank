import type { Database } from "bun:sqlite";
import { chunkText } from "./chunk.ts";
import { openDatabase } from "./db.ts";
import { normalizeFactText } from "./dedupe.ts";
import { createBruteForceCosineRanker, decodeEmbedding, prepareEmbedding } from "./embed.ts";
import { EmbedderUnavailableError, MemoryBankError, ReflectFailedError, ReflectorUnavailableError } from "./errors.ts";
import { normalizeExtractedFacts } from "./extract/validate.ts";
import {
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_HYBRID_WEIGHTS,
  DEFAULT_RRF_K,
  packHybridFacts,
  rankHybridFacts,
} from "./hybrid.ts";
import { isAssistantKnowledgeGap, junkReason } from "./knowledge-gap.ts";
import {
  acceptObservations,
  MAX_OBSERVATIONS,
  removeFacts,
  saveObservations,
  scopeKey,
} from "./reflect.ts";
import { createOllamaReflector } from "./reflector.ts";
import { recallFacts } from "./recall.ts";
import { createOllamaReranker, reorderByIds } from "./rerank.ts";
import { assertEntityType, resolveMentions, type Mention } from "./resolve.ts";
import { searchByVector } from "./semantic.ts";
import { meaningfulTokens } from "./tokens.ts";
import {
  FACT_KINDS,
  type BackfillResult,
  type Embedder,
  type ExtractedFact,
  type Extractor,
  type FactKind,
  type FactRecord,
  type ListFactsInput,
  type ListFactsResult,
  type SweepJunkInput,
  type SweepJunkResult,
  type UpdateFactResult,
  type ForgetManyResult,
  type OpenBankOptions,
  type RecallInput,
  type RecallResult,
  type RememberInput,
  type RetainInput,
  type RetainResult,
  type HybridRecallInput,
  type HybridRecallResult,
  type ReflectInput,
  type Reflector,
  type ReflectResult,
  type Reranker,
  type SemanticSearchInput,
  type VectorRanker,
} from "./types.ts";

export class MemoryBank {
  private closed = false;

  constructor(
    private readonly db: Database,
    readonly path: string,
    readonly bankId: string,
    private readonly extractor: Extractor | undefined,
    private readonly embedder: Embedder | undefined,
    private readonly ranker: VectorRanker,
    private readonly reranker: Reranker | undefined,
    private readonly reflector: Reflector | undefined,
  ) {}

  async retain(input: RetainInput): Promise<RetainResult> {
    this.assertOpen();
    const content = requiredText(input.content, "content");
    if (!this.extractor) {
      throw new MemoryBankError(
        "retain needs an extractor. Pass one to openBank(), or use remember() to save a fact without a model.",
      );
    }
    const mentionedAt = toIso(input.mentionedAt, "now");
    let extracted: unknown;
    try {
      extracted = await this.extractor.extract({
        content,
        context: input.context,
        speaker: input.speaker,
        mentionedAt,
      });
    } catch (error) {
      if (error instanceof MemoryBankError) throw error;
      throw new MemoryBankError("Extraction failed; nothing was written.", { cause: error });
    }
    const facts = factsToRetain(normalizeExtractedFacts(extracted));
    const vectors = await Promise.all(facts.map((fact) => this.vectorFor(fact.text)));
    const write = this.db.transaction((): RetainResult => {
      const sourceId = insertSource(this.db, this.bankId, {
        text: content,
        context: input.context,
        speaker: input.speaker,
        mentionedAt,
      });
      insertChunks(this.db, this.bankId, sourceId, chunkText(content));
      const saved = facts.map((fact, index) =>
        saveFact(this.db, this.bankId, {
          text: fact.text,
          kind: fact.kind,
          occurrenceTime: occurrenceFromSource(content, fact.occurrenceTime),
          mentionedAt,
          sourceId,
          mentions: fact.entities,
          vector: vectors[index] ?? null,
        }),
      );
      return { sourceId, facts: saved };
    });
    return write();
  }

  async remember(input: RememberInput): Promise<FactRecord> {
    this.assertOpen();
    const text = requiredText(input.text, "text");
    const kind = input.kind ?? "world";
    if (!FACT_KINDS.includes(kind)) {
      throw new MemoryBankError('kind must be "world" or "experience".');
    }
    const mentionedAt = toIso(input.mentionedAt, "now");
    const occurrenceTime =
      input.occurrenceTime == null ? null : toIso(input.occurrenceTime, "null");
    const mentions: Mention[] = (input.entities ?? []).map((entity) => ({
      name: entity.name,
      type: entity.type ? assertEntityType(entity.type) : "other",
    }));
    const vector = await this.vectorFor(text);

    const write = this.db.transaction(() => {
      const sourceId = insertSource(this.db, this.bankId, {
        text,
        context: undefined,
        speaker: undefined,
        mentionedAt,
      });
      insertChunks(this.db, this.bankId, sourceId, chunkText(text));
      return saveFact(this.db, this.bankId, {
        text,
        kind,
        occurrenceTime,
        mentionedAt,
        sourceId,
        mentions,
        vector,
      });
    });
    return write();
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    this.assertOpen();
    if (typeof input.query !== "string") {
      throw new MemoryBankError("query must be a string.");
    }
    return recallFacts(this.db, this.bankId, input.query, input.tokenBudget);
  }

  /**
   * Keyword, vector, and one-hop graph lists fused with reciprocal rank fusion,
   * then ordered by recency. Personal-Agents should call this. `recall` stays
   * the keyword and entity path.
   */
  async hybridRecall(input: HybridRecallInput): Promise<HybridRecallResult> {
    this.assertOpen();
    if (typeof input.query !== "string") {
      throw new MemoryBankError("query must be a string.");
    }
    const weights = {
      keyword: input.weights?.keyword ?? DEFAULT_HYBRID_WEIGHTS.keyword,
      vector: input.weights?.vector ?? DEFAULT_HYBRID_WEIGHTS.vector,
      graph: input.weights?.graph ?? DEFAULT_HYBRID_WEIGHTS.graph,
    };
    for (const value of [weights.keyword, weights.vector, weights.graph]) {
      if (!Number.isFinite(value) || value < 0) {
        throw new MemoryBankError("weights must be finite numbers of zero or more.");
      }
    }
    const rrfK = input.rrfK ?? DEFAULT_RRF_K;
    if (!Number.isFinite(rrfK) || rrfK <= 0) {
      throw new MemoryBankError("rrfK must be a finite number greater than zero.");
    }
    const halfLifeDays = input.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
    if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
      throw new MemoryBankError("halfLifeDays must be a finite number greater than zero.");
    }
    if (input.limit != null && (!Number.isInteger(input.limit) || input.limit < 0)) {
      throw new MemoryBankError("limit must be an integer of zero or more.");
    }
    if (!Number.isFinite(input.tokenBudget) || input.tokenBudget < 0) {
      throw new MemoryBankError("tokenBudget must be a finite number of zero or more.");
    }
    const now = resolveNow(input.now);

    let queryVector: Float32Array | null = null;
    if (this.embedder && input.query.trim() !== "") {
      try {
        queryVector = (await this.prepareText(input.query)).vector;
      } catch {
        queryVector = null;
      }
    }

    let ranked = rankHybridFacts(this.db, this.bankId, {
      query: input.query,
      tokenBudget: input.tokenBudget,
      limit: input.limit,
      weights,
      rrfK,
      halfLifeDays,
      now,
      queryVector,
      vectorModel: this.embedder?.model ?? null,
      ranker: this.ranker,
      includeObservations: input.includeObservations !== false,
    });

    if (input.llmRerank && ranked.length > 1) {
      const reranker = this.reranker ?? createOllamaReranker();
      try {
        const ids = await reranker.rerank({
          query: input.query,
          facts: ranked.map((fact) => ({ id: fact.id, text: fact.text })),
        });
        ranked = reorderByIds(ranked, ids);
      } catch {
        // Fusion order stands when the reranker cannot answer.
      }
    }

    return packHybridFacts(ranked, input.tokenBudget, input.limit);
  }

  /**
   * Ask the reflector for a few observations about the gathered facts.
   * Re-running the same scope updates a matching observation and drops the
   * ones the model no longer returns. Ollama being down throws and writes nothing.
   */
  async reflect(input: ReflectInput = {}): Promise<ReflectResult> {
    this.assertOpen();
    const maxObservations = input.maxObservations ?? MAX_OBSERVATIONS;
    if (!Number.isInteger(maxObservations) || maxObservations < 1) {
      throw new MemoryBankError("maxObservations must be an integer of 1 or more.");
    }
    const since = input.since == null ? undefined : toIso(input.since, "null");
    const until = input.until == null ? undefined : toIso(input.until, "null");
    const gathered = await this.gatherFacts(input, since, until);
    if (gathered.length === 0) {
      throw new ReflectFailedError("reflect found no facts in that scope. Nothing was written.");
    }
    const reflector = this.reflector ?? createOllamaReflector();
    let drafts: Awaited<ReturnType<Reflector["reflect"]>>;
    try {
      drafts = await reflector.reflect({
        topic: input.topic ?? input.entity ?? input.query,
        facts: gathered.map((fact) => ({
          id: fact.id,
          text: fact.text,
          kind: fact.kind,
          mentionedAt: fact.mentionedAt,
        })),
      });
    } catch (error) {
      if (error instanceof MemoryBankError) throw error;
      throw new ReflectorUnavailableError("Reflect failed. Nothing was written.", { cause: error });
    }
    const numeric = new Map<string, number[]>();
    const vectors = new Map<string, Awaited<ReturnType<MemoryBank["vectorFor"]>>>();
    for (const draft of drafts) {
      const key = normalizeFactText(draft.text);
      if (!key || vectors.has(key)) continue;
      const stored = await this.vectorFor(draft.text);
      vectors.set(key, stored);
      if (stored) numeric.set(key, Array.from(decodeEmbedding(stored.bytes, stored.dim) ?? []));
    }
    const accepted = acceptObservations(
      drafts,
      new Set(gathered.map((fact) => fact.id)),
      maxObservations,
      {
        singleEntity: Boolean(input.entity?.trim()) && !input.query?.trim(),
        vectors: numeric,
      },
    );
    const now = new Date().toISOString();
    return saveObservations(
      this.db,
      this.bankId,
      scopeKey({
        query: input.query,
        entity: input.entity,
        topic: input.topic,
        since,
        until,
      }),
      accepted,
      vectors,
      now,
    );
  }

  /** Remove one fact. Observations that cited only that fact are removed too. */
  forget(factId: string): ForgetManyResult {
    return this.forgetMany([factId]);
  }

  forgetMany(ids: readonly string[]): ForgetManyResult {
    this.assertOpen();
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new MemoryBankError("forgetMany requires at least one fact id.");
    }
    if (ids.some((id) => typeof id !== "string" || id.trim() === "")) {
      throw new MemoryBankError("factId must be a non-empty string.");
    }
    return removeFacts(this.db, this.bankId, ids);
  }

  /** Lists stored junk and, only when dryRun is false, deletes it. */
  sweepJunk(input: SweepJunkInput = {}): SweepJunkResult {
    this.assertOpen();
    const dryRun = input.dryRun ?? true;
    const rows = this.db
      .query("SELECT id, text FROM facts WHERE bank_id = ? ORDER BY id")
      .all(this.bankId) as Array<{ id: string; text: string }>;
    const candidates = rows.flatMap((row) => {
      const reason = junkReason(row.text);
      return reason == null ? [] : [{ id: row.id, text: row.text, reason }];
    });
    if (dryRun || candidates.length === 0) {
      return {
        dryRun,
        candidates,
        deleted: 0,
        removedObservationIds: [],
        removedEntityIds: [],
      };
    }
    const removed = removeFacts(
      this.db,
      this.bankId,
      candidates.map((candidate) => candidate.id),
    );
    return {
      dryRun: false,
      candidates,
      deleted: removed.removedFactIds.length,
      removedObservationIds: removed.removedObservationIds,
      removedEntityIds: removed.removedEntityIds,
    };
  }

  listFacts(input: ListFactsInput): ListFactsResult {
    this.assertOpen();
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new MemoryBankError("limit must be an integer from 1 to 100.");
    }
    const offset = input.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new MemoryBankError("offset must be an integer of zero or more.");
    }
    if (input.kind != null && !FACT_KINDS.includes(input.kind)) {
      throw new MemoryBankError('kind must be "world" or "experience".');
    }
    const where = ["f.bank_id = ?"];
    const params: Array<string | number> = [this.bankId];
    if (input.kind) {
      where.push("f.kind = ?");
      params.push(input.kind);
    }
    const entity = input.entity?.trim();
    if (entity) {
      where.push(
        `EXISTS (
           SELECT 1 FROM edges g
           JOIN entities e ON e.id = g.entity_id AND e.bank_id = g.bank_id
           WHERE g.bank_id = f.bank_id AND g.fact_id = f.id AND g.edge_type = 'mentions'
             AND (lower(e.canonical_name) = lower(?) OR lower(e.aliases_json) LIKE ?)
         )`,
      );
      params.push(entity, `%${entity.toLowerCase()}%`);
    }
    for (const token of meaningfulTokens(input.query ?? "")) {
      where.push("lower(f.text) LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(token)}%`);
    }
    const clause = where.join(" AND ");
    const totalRow = this.db
      .query(`SELECT COUNT(*) AS n FROM facts f WHERE ${clause}`)
      .get(...params) as { n: number | bigint };
    const rows = this.db
      .query(
        `SELECT f.id AS id, f.text AS text, f.kind AS kind, f.occurrence_time AS occurrence_time,
                f.mentioned_at AS mentioned_at, f.source_id AS source_id
         FROM facts f
         WHERE ${clause}
         ORDER BY f.mentioned_at DESC, f.id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, input.limit, offset) as StoredFact[];
    return {
      facts: rows.map((row) => factRecord(this.db, this.bankId, row)),
      total: Number(totalRow.n),
    };
  }

  async updateFact(id: string, text: string): Promise<UpdateFactResult> {
    this.assertOpen();
    if (typeof id !== "string" || id.trim() === "") {
      throw new MemoryBankError("factId must be a non-empty string.");
    }
    const next = requiredText(text, "text");
    const vector = await this.vectorFor(next);
    const write = this.db.transaction(() => {
      const current = this.db
        .query("SELECT id FROM facts WHERE id = ? AND bank_id = ?")
        .get(id, this.bankId) as { id: string } | null;
      if (!current) throw new MemoryBankError("No fact with that id is in this bank.");
      const duplicate = findIdenticalFact(this.db, this.bankId, next, id);
      if (duplicate) {
        moveFactMentions(this.db, this.bankId, duplicate.id, id);
        if (vector) {
          this.db
            .query(
              `UPDATE facts
               SET embedding = ?, embedding_model = ?, embedding_dim = ?
               WHERE id = ? AND bank_id = ? AND embedding IS NULL`,
            )
            .run(vector.bytes, vector.model, vector.dim, duplicate.id, this.bankId);
        }
        removeFacts(this.db, this.bankId, [id]);
        const kept = this.db
          .query(
            `SELECT id, text, kind, occurrence_time, mentioned_at, source_id
             FROM facts WHERE id = ? AND bank_id = ?`,
          )
          .get(duplicate.id, this.bankId) as StoredFact;
        return { fact: factRecord(this.db, this.bankId, kept), mergedIntoExisting: true };
      }
      this.db
        .query(
          `UPDATE facts
           SET text = ?, embedding = ?, embedding_model = ?, embedding_dim = ?
           WHERE id = ? AND bank_id = ?`,
        )
        .run(next.trim(), vector?.bytes ?? null, vector?.model ?? null, vector?.dim ?? null, id, this.bankId);
      const updated = this.db
        .query(
          `SELECT id, text, kind, occurrence_time, mentioned_at, source_id
           FROM facts WHERE id = ? AND bank_id = ?`,
        )
        .get(id, this.bankId) as StoredFact;
      return { fact: factRecord(this.db, this.bankId, updated), mergedIntoExisting: false };
    });
    return write();
  }

  private async gatherFacts(
    input: ReflectInput,
    since: string | undefined,
    until: string | undefined,
  ): Promise<Array<{ id: string; text: string; kind: string; mentionedAt: string; occurrenceTime: string | null }>> {
    const query = [input.query, input.topic, input.entity]
      .filter((part): part is string => typeof part === "string" && part.trim() !== "")
      .join(" ");
    const sinceMs = since == null ? null : Date.parse(since);
    const untilMs = until == null ? null : Date.parse(until);
    let rows: Array<{ id: string; text: string; kind: string; mentionedAt: string; occurrenceTime: string | null }> =
      [];
    if (query !== "") {
      const recalled = await this.hybridRecall({
        query,
        tokenBudget: 4000,
        limit: 40,
        includeObservations: false,
        now: input.now,
      });
      const ranked = recalled.facts.filter((fact) => !fact.derived && fact.score > 0);
      const best = ranked.reduce((max, fact) => Math.max(max, fact.score), 0);
      const cutoff = best * 0.5;
      rows = ranked
        .filter((fact) => fact.score >= cutoff)
        .map((fact) => ({
          id: fact.id,
          text: fact.text,
          kind: fact.kind,
          mentionedAt: fact.mentionedAt,
          occurrenceTime: fact.occurrenceTime,
        }));
    } else {
      rows = (
        this.db
          .query(
            `SELECT id, text, kind, occurrence_time, mentioned_at
             FROM facts
             WHERE bank_id = ?
             ORDER BY mentioned_at DESC
             LIMIT 40`,
          )
          .all(this.bankId) as Array<{
          id: string;
          text: string;
          kind: string;
          occurrence_time: string | null;
          mentioned_at: string;
        }>
      ).map((row) => ({
        id: row.id,
        text: row.text,
        kind: row.kind,
        mentionedAt: row.mentioned_at,
        occurrenceTime: row.occurrence_time,
      }));
    }
    if (sinceMs == null && untilMs == null) return rows;
    return rows.filter((row) => {
      const ms = Date.parse(row.occurrenceTime ?? row.mentionedAt);
      if (Number.isNaN(ms)) return false;
      if (sinceMs != null && ms < sinceMs) return false;
      if (untilMs != null && ms >= untilMs) return false;
      return true;
    });
  }

  async semanticSearch(input: SemanticSearchInput): Promise<RecallResult> {
    this.assertOpen();
    if (typeof input.query !== "string") {
      throw new MemoryBankError("query must be a string.");
    }
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new MemoryBankError("limit must be an integer of zero or more.");
    }
    if (!Number.isFinite(input.tokenBudget) || input.tokenBudget < 0) {
      throw new MemoryBankError("tokenBudget must be a finite number of zero or more.");
    }
    if (input.query.trim() === "" || input.tokenBudget === 0 || limit === 0) {
      return { facts: [], tokensUsed: 0 };
    }
    if (!this.embedder) {
      throw new MemoryBankError(
        "semanticSearch needs an embedder. Pass createOllamaEmbedder() to openBank().",
      );
    }
    if (this.countEmbedded(this.embedder.model) === 0) {
      return { facts: [], tokensUsed: 0 };
    }
    const prepared = await this.prepareText(input.query);
    return searchByVector(
      this.db,
      this.bankId,
      prepared.vector,
      this.embedder.model,
      input.tokenBudget,
      limit,
      this.ranker,
    );
  }

  /**
   * Embeds facts in this bank that have no vector. Rows already written are
   * committed before the next fact, so a failure can be retried.
   */
  async backfillEmbeddings(): Promise<BackfillResult> {
    this.assertOpen();
    const embedder = this.embedder;
    if (!embedder) {
      throw new MemoryBankError(
        "backfillEmbeddings needs an embedder. Pass createOllamaEmbedder() to openBank().",
      );
    }
    const rows = this.db
      .query(
        `SELECT id, text
         FROM facts
         WHERE bank_id = ? AND embedding IS NULL
         ORDER BY created_at ASC, id ASC`,
      )
      .all(this.bankId) as Array<{ id: string; text: string }>;

    let embedded = 0;
    for (const row of rows) {
      const prepared = await this.prepareText(row.text);
      const result = this.db
        .query(
          `UPDATE facts
           SET embedding = ?, embedding_model = ?, embedding_dim = ?
           WHERE id = ? AND bank_id = ? AND embedding IS NULL`,
        )
        .run(prepared.bytes, embedder.model, prepared.dim, row.id, this.bankId);
      embedded += Number(result.changes);
    }
    return { embedded, remaining: this.countMissing() };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new MemoryBankError("This memory bank is closed.");
  }

  /** Null when no embedder is configured or the embedder cannot answer. The fact is still stored. */
  private async vectorFor(text: string): Promise<StoredVector | null> {
    if (!this.embedder) return null;
    const model = this.embedder.model;
    try {
      const prepared = await this.prepareText(text);
      return { model, dim: prepared.dim, bytes: prepared.bytes };
    } catch {
      return null;
    }
  }

  private async prepareText(text: string): Promise<{ dim: number; bytes: Uint8Array; vector: Float32Array }> {
    if (!this.embedder) {
      throw new MemoryBankError(
        "An embedder is required. Pass createOllamaEmbedder() to openBank().",
      );
    }
    let raw: readonly number[];
    try {
      raw = await this.embedder.embed(text);
    } catch (error) {
      if (error instanceof EmbedderUnavailableError) throw error;
      throw new EmbedderUnavailableError("Embedding failed.", { cause: error });
    }
    const prepared = prepareEmbedding(raw);
    if (!prepared) throw new EmbedderUnavailableError("Embedder returned an empty vector.");
    return prepared;
  }

  private countEmbedded(model: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n
         FROM facts
         WHERE bank_id = ? AND embedding IS NOT NULL AND embedding_model = ?`,
      )
      .get(this.bankId, model) as { n: number | bigint };
    return Number(row.n);
  }

  private countMissing(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM facts WHERE bank_id = ? AND embedding IS NULL")
      .get(this.bankId) as { n: number | bigint };
    return Number(row.n);
  }
}

export function openBank(path: string, options: OpenBankOptions = {}): MemoryBank {
  if (typeof path !== "string" || path.trim() === "") {
    throw new MemoryBankError("openBank requires a SQLite file path.");
  }
  const bankId = (options.bankId ?? "default").trim();
  if (!bankId) throw new MemoryBankError("bankId cannot be empty.");
  return new MemoryBank(
    openDatabase(path),
    path,
    bankId,
    options.extractor,
    options.embedder ?? undefined,
    options.vectorRanker ?? createBruteForceCosineRanker(),
    options.reranker ?? undefined,
    options.reflector ?? undefined,
  );
}

function resolveNow(value: string | Date | undefined): Date {
  if (value == null) return new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new MemoryBankError(`Invalid time: ${String(value)}`);
  return date;
}

const MAX_RETAINED_FACTS = 5;

/** Automatic retain only. remember() saves the caller's text as given. */
function factsToRetain(facts: ExtractedFact[]): ExtractedFact[] {
  return facts.filter((fact) => !isAssistantKnowledgeGap(fact.text)).slice(0, MAX_RETAINED_FACTS);
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MemoryBankError(`${label} must be a non-empty string.`);
  }
  return value;
}

const WEEKDAY =
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const MONTH_THEN_DAY =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i;
const DAY_THEN_MONTH =
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?!\d)/;
const NUMERIC_DATE = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?!\d)|\b\d{1,2}-\d{1,2}-\d{4}\b/;
const ORDINAL_DAY = /\b(?:on|the)\s+\d{1,2}(?:st|nd|rd|th)\b/i;
const RELATIVE_DAY =
  /\b(?:yesterday|today|tomorrow|tonight)\b|\bago\b|\b(?:this|last|next)\s+(?:morning|afternoon|evening|night|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

/** A clock time or a preference is not an occurrence. Missing stays null, never "now". */
function occurrenceFromSource(content: string, extracted: string | null): string | null {
  if (extracted == null) return null;
  if (!sourceNamesOccurrence(content)) return null;
  return extracted;
}

function sourceNamesOccurrence(text: string): boolean {
  return (
    WEEKDAY.test(text) ||
    MONTH_THEN_DAY.test(text) ||
    DAY_THEN_MONTH.test(text) ||
    ISO_DATE.test(text) ||
    NUMERIC_DATE.test(text) ||
    ORDINAL_DAY.test(text) ||
    RELATIVE_DAY.test(text)
  );
}

function toIso(value: string | Date | null | undefined, fallback: "now" | "null"): string {
  if (value == null) {
    if (fallback === "now") return new Date().toISOString();
    throw new MemoryBankError("Missing time.");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MemoryBankError(`Invalid time: ${String(value)}`);
  }
  return date.toISOString();
}

function insertSource(
  db: Database,
  bankId: string,
  source: { text: string; context?: string; speaker?: string; mentionedAt: string },
): string {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO sources (id, bank_id, text, context, speaker, mentioned_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    bankId,
    source.text,
    source.context ?? null,
    source.speaker ?? null,
    source.mentionedAt,
    new Date().toISOString(),
  );
  return id;
}

function insertChunks(db: Database, bankId: string, sourceId: string, chunks: string[]): void {
  const statement = db.query(
    `INSERT INTO source_chunks (id, bank_id, source_id, ordinal, text)
     VALUES (?, ?, ?, ?, ?)`,
  );
  chunks.forEach((text, ordinal) => {
    statement.run(crypto.randomUUID(), bankId, sourceId, ordinal, text);
  });
}

interface StoredVector {
  model: string;
  dim: number;
  bytes: Uint8Array;
}

function saveFact(
  db: Database,
  bankId: string,
  fact: {
    text: string;
    kind: FactKind;
    occurrenceTime: string | null;
    mentionedAt: string;
    sourceId: string;
    mentions: Mention[];
    vector: StoredVector | null;
  },
): FactRecord {
  const entities = resolveMentions(db, bankId, fact.mentions);
  const existing = findIdenticalFact(db, bankId, fact.text);
  if (existing) {
    linkMentions(db, bankId, existing.id, entities);
    if (fact.vector) {
      db.query(
        `UPDATE facts
         SET embedding = ?, embedding_model = ?, embedding_dim = ?
         WHERE id = ? AND bank_id = ? AND embedding IS NULL`,
      ).run(fact.vector.bytes, fact.vector.model, fact.vector.dim, existing.id, bankId);
    }
    return {
      id: existing.id,
      text: existing.text,
      kind: existing.kind as FactKind,
      occurrenceTime: fillOccurrenceTime(db, bankId, existing, fact.occurrenceTime),
      mentionedAt: existing.mentioned_at,
      sourceId: existing.source_id,
      entities: entitiesForFact(db, bankId, existing.id),
    };
  }

  const id = crypto.randomUUID();
  const text = fact.text.trim();
  db.query(
    `INSERT INTO facts (
       id, bank_id, text, kind, occurrence_time, mentioned_at, source_id, created_at,
       embedding, embedding_model, embedding_dim
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    bankId,
    text,
    fact.kind,
    fact.occurrenceTime,
    fact.mentionedAt,
    fact.sourceId,
    new Date().toISOString(),
    fact.vector?.bytes ?? null,
    fact.vector?.model ?? null,
    fact.vector?.dim ?? null,
  );
  linkMentions(db, bankId, id, entities);
  return {
    id,
    text,
    kind: fact.kind,
    occurrenceTime: fact.occurrenceTime,
    mentionedAt: fact.mentionedAt,
    sourceId: fact.sourceId,
    entities,
  };
}

interface StoredFact {
  id: string;
  text: string;
  kind: string;
  occurrence_time: string | null;
  mentioned_at: string;
  source_id: string;
}

function findIdenticalFact(
  db: Database,
  bankId: string,
  text: string,
  exceptId?: string,
): StoredFact | null {
  const target = normalizeFactText(text);
  if (!target) return null;
  const rows = db
    .query(
      `SELECT id, text, kind, occurrence_time, mentioned_at, source_id
       FROM facts
       WHERE bank_id = ?
       ORDER BY created_at ASC, mentioned_at ASC, id ASC`,
    )
    .all(bankId) as StoredFact[];
  return rows.find((row) => row.id !== exceptId && normalizeFactText(row.text) === target) ?? null;
}

function factRecord(db: Database, bankId: string, row: StoredFact): FactRecord {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind as FactKind,
    occurrenceTime: row.occurrence_time,
    mentionedAt: row.mentioned_at,
    sourceId: row.source_id,
    entities: entitiesForFact(db, bankId, row.id),
  };
}

function moveFactMentions(db: Database, bankId: string, keeperId: string, extraId: string): void {
  const edges = db
    .query(
      `SELECT entity_id FROM edges
       WHERE bank_id = ? AND edge_type = 'mentions' AND fact_id = ?`,
    )
    .all(bankId, extraId) as Array<{ entity_id: string }>;
  const insert = db.query(
    `INSERT OR IGNORE INTO edges (id, bank_id, edge_type, fact_id, entity_id)
     VALUES (?, ?, 'mentions', ?, ?)`,
  );
  for (const edge of edges) {
    insert.run(crypto.randomUUID(), bankId, keeperId, edge.entity_id);
  }
}

function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function fillOccurrenceTime(
  db: Database,
  bankId: string,
  existing: StoredFact,
  incoming: string | null,
): string | null {
  if (existing.occurrence_time != null) return existing.occurrence_time;
  if (incoming == null) return null;
  db.query(
    `UPDATE facts
     SET occurrence_time = ?
     WHERE id = ? AND bank_id = ? AND occurrence_time IS NULL`,
  ).run(incoming, existing.id, bankId);
  return incoming;
}

function linkMentions(
  db: Database,
  bankId: string,
  factId: string,
  entities: FactRecord["entities"],
): void {
  const link = db.query(
    `INSERT OR IGNORE INTO edges (id, bank_id, edge_type, fact_id, entity_id)
     VALUES (?, ?, 'mentions', ?, ?)`,
  );
  for (const entity of entities) {
    link.run(crypto.randomUUID(), bankId, factId, entity.id);
  }
}

function entitiesForFact(db: Database, bankId: string, factId: string): FactRecord["entities"] {
  const rows = db
    .query(
      `SELECT e.id AS id, e.canonical_name AS name, e.type AS type
       FROM edges g
       JOIN entities e ON e.id = g.entity_id AND e.bank_id = g.bank_id
       WHERE g.bank_id = ? AND g.edge_type = 'mentions' AND g.fact_id = ?
       ORDER BY e.canonical_name, e.id`,
    )
    .all(bankId, factId) as Array<{ id: string; name: string; type: string }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: assertEntityType(row.type),
  }));
}
