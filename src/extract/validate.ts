import { ExtractionFailedError } from "../errors.ts";
import { ENTITY_TYPES, type EntityType, type ExtractedFact, type FactKind } from "../types.ts";

const MAX_FACTS = 5;
const MAX_FACT_CHARS = 2000;

export function normalizeExtractedFacts(value: unknown): ExtractedFact[] {
  if (!Array.isArray(value)) {
    throw new ExtractionFailedError("Extractor must return a list of facts. Nothing was written.");
  }
  const facts = value.map((item) => normalizeFact(item));
  return facts.slice(0, MAX_FACTS);
}

function normalizeFact(item: unknown): ExtractedFact {
  if (!item || typeof item !== "object") {
    throw new ExtractionFailedError("Each fact must be an object. Nothing was written.");
  }
  const record = item as Record<string, unknown>;
  if (typeof record.text !== "string" || record.text.trim() === "") {
    throw new ExtractionFailedError("Each fact needs text. Nothing was written.");
  }
  const text = record.text.trim();
  if (text.length > MAX_FACT_CHARS) {
    throw new ExtractionFailedError("A fact is too long to store. Nothing was written.");
  }
  if (record.kind !== "world" && record.kind !== "experience") {
    throw new ExtractionFailedError(
      'Fact kind must be "world" or "experience". Nothing was written.',
    );
  }
  const kind: FactKind = record.kind;
  let occurrenceTime: string | null = null;
  if (record.occurrenceTime != null) {
    if (typeof record.occurrenceTime !== "string" || Number.isNaN(Date.parse(record.occurrenceTime))) {
      throw new ExtractionFailedError(
        "occurrenceTime must be an ISO-8601 string or null. Nothing was written.",
      );
    }
    occurrenceTime = new Date(record.occurrenceTime).toISOString();
  }
  return {
    text,
    kind,
    occurrenceTime,
    entities: normalizeEntities(record.entities),
  };
}

function normalizeEntities(value: unknown): ExtractedFact["entities"] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ExtractionFailedError("Fact entities must be a list. Nothing was written.");
  }
  return value.map((entity) => {
    if (!entity || typeof entity !== "object") {
      throw new ExtractionFailedError("Each entity needs a name and type. Nothing was written.");
    }
    const record = entity as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.trim() === "") {
      throw new ExtractionFailedError("Each entity needs a name. Nothing was written.");
    }
    if (typeof record.type !== "string" || !ENTITY_TYPES.includes(record.type as EntityType)) {
      throw new ExtractionFailedError(
        `Entity type must be one of: ${ENTITY_TYPES.join(", ")}. Nothing was written.`,
      );
    }
    return { name: record.name.trim(), type: record.type as EntityType };
  });
}
