import type { Database } from "bun:sqlite";
import { MemoryBankError } from "./errors.ts";
import { normalizeName } from "./names.ts";
import { assertEntityType } from "./resolve.ts";
import { isSealed, openText } from "./sealed.ts";
import { estimateTokens, meaningfulTokens, tokenize } from "./tokens.ts";
import type { FactKind, RecalledFact, RecallResult } from "./types.ts";

interface EntityHit {
  id: string;
  canonical_name: string;
  aliases_json: string;
  type: string;
}

interface FactRow {
  id: string;
  text: string;
  kind: string;
  occurrence_time: string | null;
  mentioned_at: string;
  source_id: string;
}

interface LinkRow {
  fact_id: string;
  id: string;
  name: string;
  type: string;
}

/**
 * Entity lookup plus keyword overlap. Facts are packed in rank order.
 * A fact that does not fit the remaining budget is skipped, so one long
 * fact cannot crowd out a shorter relevant one. Source text is never returned.
 */
export function recallFacts(
  db: Database,
  bankId: string,
  query: string,
  tokenBudget: number,
): RecallResult {
  if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
    throw new MemoryBankError("tokenBudget must be a finite number of zero or more.");
  }
  const tokens = meaningfulTokens(query);
  if (tokens.length === 0 || tokenBudget === 0) {
    return { facts: [], tokensUsed: 0 };
  }

  const tokenSet = new Set(tokens);
  const queryNorm = normalizeName(query);
  const entityScores = scoreEntities(db, bankId, queryNorm, tokenSet);
  const matchedEntityIds = [...entityScores.keys()];
  const factIds = candidateFactIds(db, bankId, matchedEntityIds, tokens);
  if (factIds.length === 0) return { facts: [], tokensUsed: 0 };

  const facts = loadFacts(db, bankId, factIds);
  const links = loadLinks(db, bankId, factIds);
  const ranked: RecalledFact[] = [];

  for (const fact of facts) {
    const entities = links.get(fact.id) ?? [];
    let score = 0;
    for (const entity of entities) score += entityScores.get(entity.id) ?? 0;
    const factTokens = new Set(tokenize(fact.text));
    for (const token of tokens) {
      if (factTokens.has(token)) score += 2;
    }
    if (score <= 0) continue;
    ranked.push({
      id: fact.id,
      text: fact.text,
      kind: fact.kind as FactKind,
      occurrenceTime: fact.occurrence_time,
      mentionedAt: fact.mentioned_at,
      sourceId: fact.source_id,
      entities,
      score,
    });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.mentionedAt !== right.mentionedAt) return left.mentionedAt < right.mentionedAt ? 1 : -1;
    return left.id < right.id ? -1 : 1;
  });

  const selected: RecalledFact[] = [];
  let tokensUsed = 0;
  for (const fact of ranked) {
    const cost = estimateTokens(fact.text);
    if (cost > tokenBudget || tokensUsed + cost > tokenBudget) continue;
    selected.push(fact);
    tokensUsed += cost;
  }
  return { facts: selected, tokensUsed };
}

function scoreEntities(
  db: Database,
  bankId: string,
  queryNorm: string,
  queryTokens: Set<string>,
): Map<string, number> {
  const rows = db
    .query(
      `SELECT id, canonical_name, canonical_name_enc, aliases_json, aliases_enc, type
       FROM entities WHERE bank_id = ?`,
    )
    .all(bankId) as Array<EntityHit & { canonical_name_enc: unknown; aliases_enc: unknown }>;
  for (const row of rows) {
    row.canonical_name =
      openText(db, "entities", "canonical_name", row.id, row.canonical_name, row.canonical_name_enc, true) ?? "";
    row.aliases_json = openText(db, "entities", "aliases", row.id, row.aliases_json, row.aliases_enc, false) ?? "[]";
  }
  const scores = new Map<string, number>();
  const paddedQuery = ` ${queryNorm} `;
  for (const row of rows) {
    const names = [row.canonical_name, ...parseAliases(row.aliases_json)];
    let best = 0;
    for (const name of names) {
      const norm = normalizeName(name);
      if (!norm) continue;
      const parts = norm.split(" ");
      if (paddedQuery.includes(` ${norm} `)) {
        best = Math.max(best, 10 + parts.length * 3);
        continue;
      }
      const overlap = parts.filter((part) => part.length >= 3 && queryTokens.has(part));
      if (overlap.length === parts.length) best = Math.max(best, 5 + parts.length * 2);
      else if (overlap.length > 0) best = Math.max(best, overlap.length * 2);
    }
    if (best > 0) scores.set(row.id, best);
  }
  return scores;
}

function candidateFactIds(
  db: Database,
  bankId: string,
  entityIds: string[],
  tokens: string[],
): string[] {
  const ids = new Set<string>();
  if (entityIds.length > 0) {
    for (const row of selectIds<{ id: string }>(
      db,
      "SELECT DISTINCT fact_id AS id FROM edges WHERE bank_id = ? AND edge_type = 'mentions' AND entity_id IN (",
      ")",
      bankId,
      entityIds,
    )) {
      ids.add(row.id);
    }
  }
  if (isSealed(db)) {
    const rows = db
      .query("SELECT id, text, text_enc FROM facts WHERE bank_id = ?")
      .all(bankId) as Array<{ id: string; text: string; text_enc: unknown }>;
    for (const row of rows) {
      const text = (openText(db, "facts", "text", row.id, row.text, row.text_enc, true) ?? "").toLowerCase();
      if (tokens.some((token) => text.includes(token))) ids.add(row.id);
    }
    return [...ids];
  }
  const like = db.query(
    "SELECT id FROM facts WHERE bank_id = ? AND lower(text) LIKE ? ESCAPE '\\'",
  );
  for (const token of tokens) {
    const rows = like.all(bankId, `%${escapeLike(token)}%`) as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
  }
  return [...ids];
}

function loadFacts(db: Database, bankId: string, factIds: string[]): FactRow[] {
  return selectIds<FactRow>(
    db,
    `SELECT id, text, text_enc, kind, occurrence_time, mentioned_at, source_id
     FROM facts WHERE bank_id = ? AND id IN (`,
    ")",
    bankId,
    factIds,
  ).map((row) => {
    const stored = row as FactRow & { text_enc: unknown };
    return {
      ...stored,
      text: openText(db, "facts", "text", stored.id, stored.text, stored.text_enc, true) ?? "",
    };
  });
}

function loadLinks(db: Database, bankId: string, factIds: string[]): Map<string, RecalledFact["entities"]> {
  const rows = selectIds<LinkRow>(
    db,
    `SELECT g.fact_id AS fact_id, e.id AS id, e.canonical_name AS name,
            e.canonical_name_enc AS name_enc, e.type AS type
     FROM edges g
     JOIN entities e ON e.id = g.entity_id AND e.bank_id = g.bank_id
     WHERE g.bank_id = ? AND g.edge_type = 'mentions' AND g.fact_id IN (`,
    ") ORDER BY e.canonical_name, e.id",
    bankId,
    factIds,
  );
  const links = new Map<string, RecalledFact["entities"]>();
  for (const row of rows) {
    const stored = row as LinkRow & { name_enc: unknown };
    const name = openText(db, "entities", "canonical_name", stored.id, stored.name, stored.name_enc, true) ?? "";
    const list = links.get(stored.fact_id) ?? [];
    list.push({ id: stored.id, name, type: assertEntityType(stored.type) });
    links.set(stored.fact_id, list);
  }
  if (isSealed(db)) {
    for (const list of links.values()) {
      list.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : left.id < right.id ? -1 : 1));
    }
  }
  return links;
}

function selectIds<T>(
  db: Database,
  prefix: string,
  suffix: string,
  bankId: string,
  ids: string[],
): T[] {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const slice = ids.slice(offset, offset + 200);
    const marks = slice.map(() => "?").join(", ");
    const found = db.query(`${prefix}${marks}${suffix}`).all(bankId, ...slice) as T[];
    rows.push(...found);
  }
  return rows;
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

function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (character) => `\\${character}`);
}
