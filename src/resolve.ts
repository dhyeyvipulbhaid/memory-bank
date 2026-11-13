import type { Database } from "bun:sqlite";
import { MemoryBankError } from "./errors.ts";
import { displayName, matchStrength, nameTokens, normalizeName, type NameMatch } from "./names.ts";
import { exactEntityIds, isSealed, openText, sealText, storedPlain, syncNameIndex } from "./sealed.ts";
import { ENTITY_TYPES, type EntityRef, type EntityType } from "./types.ts";

interface StoredEntity {
  id: string;
  canonical_name: string;
  aliases: string[];
  type: EntityType;
}

interface Candidate {
  entity: StoredEntity;
  strength: NameMatch;
  matchedCanonical: boolean;
}

export interface Mention {
  name: string;
  type: EntityType;
}

export function assertEntityType(type: string): EntityType {
  if (!ENTITY_TYPES.includes(type as EntityType)) {
    throw new MemoryBankError(`Entity type must be one of: ${ENTITY_TYPES.join(", ")}.`);
  }
  return type as EntityType;
}

export function resolveMentions(db: Database, bankId: string, mentions: Mention[]): EntityRef[] {
  const cleaned = mentions
    .map((mention) => ({ name: displayName(mention.name), type: mention.type }))
    .filter((mention) => mention.name.length > 0);

  const resolved: Array<EntityRef | undefined> = new Array(cleaned.length);
  const boundIds: string[] = [];
  const order = cleaned
    .map((_, index) => index)
    .sort((left, right) => nameTokens(cleaned[right]?.name ?? "").length - nameTokens(cleaned[left]?.name ?? "").length);

  const deferred: number[] = [];
  for (const index of order) {
    const mention = cleaned[index];
    if (!mention) continue;
    const indexed = exactFromIndex(db, bankId, mention);
    if (indexed) {
      resolved[index] = indexed;
      boundIds.push(indexed.id);
      continue;
    }
    const strong = choose(db, bankId, mention, boundIds, "strong");
    if (strong) {
      resolved[index] = strong;
      boundIds.push(strong.id);
    } else {
      deferred.push(index);
    }
  }

  for (const index of deferred) {
    const mention = cleaned[index];
    if (!mention) continue;
    const entity = choose(db, bankId, mention, boundIds, "any") ?? createEntity(db, bankId, mention);
    resolved[index] = entity;
    boundIds.push(entity.id);
  }

  const unique: EntityRef[] = [];
  const seen = new Set<string>();
  for (const entity of resolved) {
    if (!entity || seen.has(entity.id)) continue;
    seen.add(entity.id);
    unique.push(entity);
  }
  return unique;
}

function choose(
  db: Database,
  bankId: string,
  mention: Mention,
  boundIds: string[],
  mode: "strong" | "any",
): EntityRef | null {
  const pool = candidatesFor(mention, loadEntities(db, bankId));
  const exact = pool.filter((candidate) => candidate.strength === "exact");
  const typos = pool.filter((candidate) => candidate.strength === "typo");
  const weak = pool.filter((candidate) => candidate.strength === "weak");

  if (exact.length === 1) return applyMatch(db, bankId, exact[0]!, mention);
  if (exact.length > 1) {
    const winner = cooccurrenceWinner(db, bankId, exact, boundIds);
    if (winner) return applyMatch(db, bankId, winner, mention);
    const canonicals = exact.filter((candidate) => candidate.matchedCanonical);
    if (canonicals.length === 1) return applyMatch(db, bankId, canonicals[0]!, mention);
    return null;
  }

  if (typos.length === 1) return applyMatch(db, bankId, typos[0]!, mention);
  if (typos.length > 1) {
    const winner = cooccurrenceWinner(db, bankId, typos, boundIds);
    return winner ? applyMatch(db, bankId, winner, mention) : null;
  }

  if (mode === "strong") return null;
  if (weak.length === 1) return applyMatch(db, bankId, weak[0]!, mention);
  if (weak.length > 1) {
    const winner = cooccurrenceWinner(db, bankId, weak, boundIds);
    return winner ? applyMatch(db, bankId, winner, mention) : null;
  }
  return null;
}

function candidatesFor(mention: Mention, entities: StoredEntity[]): Candidate[] {
  const found: Candidate[] = [];
  for (const entity of entities) {
    if (!typesCompatible(mention.type, entity.type)) continue;
    let best: Candidate | null = null;
    const names = [
      { value: entity.canonical_name, canonical: true },
      ...entity.aliases.map((alias) => ({ value: alias, canonical: false })),
    ];
    for (const name of names) {
      const strength = matchStrength(mention.name, name.value);
      if (!strength) continue;
      const matchedCanonical = name.canonical && normalizeName(name.value) === normalizeName(mention.name);
      if (!best || strengthRank(strength) > strengthRank(best.strength)) {
        best = { entity, strength, matchedCanonical };
      } else if (strength === best.strength && matchedCanonical) {
        best = { entity, strength, matchedCanonical: true };
      }
    }
    if (best) found.push(best);
  }
  return found;
}

function strengthRank(strength: NameMatch): number {
  if (strength === "exact") return 3;
  if (strength === "typo") return 2;
  return 1;
}

function cooccurrenceWinner(
  db: Database,
  bankId: string,
  pool: Candidate[],
  boundIds: string[],
): Candidate | null {
  const candidateIds = pool.map((candidate) => candidate.entity.id);
  const others = boundIds.filter((id) => !candidateIds.includes(id));
  if (candidateIds.length === 0 || others.length === 0) return null;

  const scores = new Map<string, number>();
  const candidateMarks = candidateIds.map(() => "?").join(", ");
  const otherMarks = others.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT e.entity_id AS candidate_id, COUNT(DISTINCT e.fact_id) AS n
       FROM edges e
       JOIN edges o
         ON o.fact_id = e.fact_id
        AND o.bank_id = e.bank_id
        AND o.edge_type = 'mentions'
        AND o.entity_id != e.entity_id
       WHERE e.bank_id = ?
         AND e.edge_type = 'mentions'
         AND e.entity_id IN (${candidateMarks})
         AND o.entity_id IN (${otherMarks})
       GROUP BY e.entity_id`,
    )
    .all(bankId, ...candidateIds, ...others) as Array<{ candidate_id: string; n: number }>;

  for (const row of rows) scores.set(row.candidate_id, Number(row.n));

  let best: Candidate | null = null;
  let bestScore = 0;
  let tied = false;
  for (const candidate of pool) {
    const score = scores.get(candidate.entity.id) ?? 0;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }
  if (!best || tied || bestScore <= 0) return null;
  return best;
}

function applyMatch(db: Database, bankId: string, candidate: Candidate, mention: Mention): EntityRef {
  let canonical = candidate.entity.canonical_name;
  let aliases = [...candidate.entity.aliases];
  let type = candidate.entity.type;
  if (type === "other" && mention.type !== "other") type = mention.type;

  if (candidate.strength === "weak") {
    const mentionTokenCount = nameTokens(mention.name).length;
    const canonicalTokenCount = nameTokens(canonical).length;
    if (mentionTokenCount > canonicalTokenCount) {
      if (normalizeName(canonical) !== normalizeName(mention.name)) aliases.push(canonical);
      canonical = mention.name;
    } else if (normalizeName(mention.name) !== normalizeName(canonical)) {
      aliases.push(mention.name);
    }
  }

  aliases = dedupeAliases(aliases, canonical);
  saveEntityNames(db, bankId, candidate.entity.id, canonical, aliases, type);
  return { id: candidate.entity.id, name: canonical, type };
}

function createEntity(db: Database, bankId: string, mention: Mention): EntityRef {
  const indexed = isSealed(db) ? new Set(exactEntityIds(db, bankId, mention.name)) : null;
  const existing = loadEntities(db, bankId).find(
    (entity) =>
      (indexed == null || indexed.has(entity.id)) &&
      typesCompatible(mention.type, entity.type) &&
      normalizeName(entity.canonical_name) === normalizeName(mention.name),
  );
  if (existing) {
    return applyMatch(
      db,
      bankId,
      { entity: existing, strength: "exact", matchedCanonical: true },
      mention,
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const nameSeal = sealText(db, "entities", "canonical_name", id, mention.name, normalizeName(mention.name));
  db.query(
    `INSERT INTO entities (
       id, bank_id, canonical_name, canonical_name_enc, aliases_json, aliases_enc, name_idx, type, created_at
     ) VALUES (?, ?, ?, ?, '[]', NULL, ?, ?, ?)`,
  ).run(id, bankId, storedPlain(db, mention.name, true), nameSeal.enc, nameSeal.index, mention.type, now);
  syncNameIndex(db, bankId, id, mention.name, []);
  return { id, name: mention.name, type: mention.type };
}

function exactFromIndex(db: Database, bankId: string, mention: Mention): EntityRef | null {
  if (!isSealed(db)) return null;
  const ids = exactEntityIds(db, bankId, mention.name);
  if (ids.length !== 1) return null;
  const entity = loadEntities(db, bankId).find((row) => row.id === ids[0]);
  if (!entity || !typesCompatible(mention.type, entity.type)) return null;
  return applyMatch(
    db,
    bankId,
    {
      entity,
      strength: "exact",
      matchedCanonical: normalizeName(entity.canonical_name) === normalizeName(mention.name),
    },
    mention,
  );
}

function saveEntityNames(
  db: Database,
  bankId: string,
  id: string,
  canonical: string,
  aliases: string[],
  type: EntityType,
): void {
  const nameSeal = sealText(db, "entities", "canonical_name", id, canonical, normalizeName(canonical));
  const aliasPayload = JSON.stringify(aliases);
  const aliasSeal = aliases.length > 0 ? sealText(db, "entities", "aliases", id, aliasPayload) : null;
  db.query(
    `UPDATE entities
     SET canonical_name = ?, canonical_name_enc = ?, aliases_json = ?, aliases_enc = ?, name_idx = ?, type = ?
     WHERE id = ? AND bank_id = ?`,
  ).run(
    storedPlain(db, canonical, true),
    nameSeal.enc,
    isSealed(db) ? "[]" : aliasPayload,
    aliasSeal?.enc ?? null,
    nameSeal.index,
    type,
    id,
    bankId,
  );
  syncNameIndex(db, bankId, id, canonical, aliases);
}

function loadEntities(db: Database, bankId: string): StoredEntity[] {
  const rows = db
    .query(
      `SELECT id, canonical_name, canonical_name_enc, aliases_json, aliases_enc, type
       FROM entities WHERE bank_id = ?`,
    )
    .all(bankId) as Array<{
    id: string;
    canonical_name: string;
    canonical_name_enc: unknown;
    aliases_json: string;
    aliases_enc: unknown;
    type: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    canonical_name:
      openText(db, "entities", "canonical_name", row.id, row.canonical_name, row.canonical_name_enc, true) ?? "",
    aliases: parseAliases(
      openText(db, "entities", "aliases", row.id, row.aliases_json, row.aliases_enc, false) ?? "[]",
    ),
    type: assertEntityType(row.type),
  }));
}

function parseAliases(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((alias): alias is string => typeof alias === "string" && alias.trim() !== "");
  } catch {
    return [];
  }
}

function dedupeAliases(aliases: string[], canonical: string): string[] {
  const canonicalNorm = normalizeName(canonical);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const alias of aliases) {
    const display = displayName(alias);
    const norm = normalizeName(display);
    if (!display || !norm || norm === canonicalNorm || seen.has(norm)) continue;
    seen.add(norm);
    result.push(display);
  }
  return result;
}

function typesCompatible(incoming: EntityType, existing: EntityType): boolean {
  return incoming === existing || incoming === "other" || existing === "other";
}
