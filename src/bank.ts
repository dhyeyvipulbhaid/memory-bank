import type { Database } from "bun:sqlite";
import { chunkText } from "./chunk.ts";
import { openDatabase } from "./db.ts";
import { MemoryBankError } from "./errors.ts";
import { normalizeExtractedFacts } from "./extract/validate.ts";
import { recallFacts } from "./recall.ts";
import { assertEntityType, resolveMentions, type Mention } from "./resolve.ts";
import {
  FACT_KINDS,
  type Extractor,
  type FactKind,
  type FactRecord,
  type OpenBankOptions,
  type RecallInput,
  type RecallResult,
  type RememberInput,
  type RetainInput,
  type RetainResult,
} from "./types.ts";

export class MemoryBank {
  private closed = false;

  constructor(
    private readonly db: Database,
    readonly path: string,
    readonly bankId: string,
    private readonly extractor: Extractor | undefined,
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
    const facts = normalizeExtractedFacts(extracted);
    const write = this.db.transaction((): RetainResult => {
      const sourceId = insertSource(this.db, this.bankId, {
        text: content,
        context: input.context,
        speaker: input.speaker,
        mentionedAt,
      });
      insertChunks(this.db, this.bankId, sourceId, chunkText(content));
      const saved = facts.map((fact) =>
        saveFact(this.db, this.bankId, {
          text: fact.text,
          kind: fact.kind,
          occurrenceTime: occurrenceFromSource(content, fact.occurrenceTime),
          mentionedAt,
          sourceId,
          mentions: fact.entities,
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new MemoryBankError("This memory bank is closed.");
  }
}

export function openBank(path: string, options: OpenBankOptions = {}): MemoryBank {
  if (typeof path !== "string" || path.trim() === "") {
    throw new MemoryBankError("openBank requires a SQLite file path.");
  }
  const bankId = (options.bankId ?? "default").trim();
  if (!bankId) throw new MemoryBankError("bankId cannot be empty.");
  return new MemoryBank(openDatabase(path), path, bankId, options.extractor);
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
  },
): FactRecord {
  const entities = resolveMentions(db, bankId, fact.mentions);
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO facts (id, bank_id, text, kind, occurrence_time, mentioned_at, source_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    bankId,
    fact.text.trim(),
    fact.kind,
    fact.occurrenceTime,
    fact.mentionedAt,
    fact.sourceId,
    new Date().toISOString(),
  );
  const link = db.query(
    `INSERT INTO edges (id, bank_id, edge_type, fact_id, entity_id)
     VALUES (?, ?, 'mentions', ?, ?)`,
  );
  for (const entity of entities) {
    link.run(crypto.randomUUID(), bankId, id, entity.id);
  }
  return {
    id,
    text: fact.text.trim(),
    kind: fact.kind,
    occurrenceTime: fact.occurrenceTime,
    mentionedAt: fact.mentionedAt,
    sourceId: fact.sourceId,
    entities,
  };
}
