import type { Database } from "bun:sqlite";

/**
 * Exact text match for one bank: trim, collapse whitespace, ignore case.
 * Punctuation stays, so this is not a semantic or embedding comparison.
 */
export function normalizeFactText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

interface FactRow {
  id: string;
  bank_id: string;
  text: string;
  occurrence_time: string | null;
  mentioned_at: string;
  created_at: string;
}

/** Keep the oldest fact for each normalized text in a bank and drop the copies. */
export function dedupeIdenticalFacts(db: Database): void {
  const rows = db
    .query(
      `SELECT id, bank_id, text, occurrence_time, mentioned_at, created_at
       FROM facts`,
    )
    .all() as FactRow[];

  const groups = new Map<string, Map<string, FactRow[]>>();
  for (const row of rows) {
    const normalized = normalizeFactText(row.text);
    if (!normalized) continue;
    let byText = groups.get(row.bank_id);
    if (!byText) {
      byText = new Map();
      groups.set(row.bank_id, byText);
    }
    const list = byText.get(normalized);
    if (list) list.push(row);
    else byText.set(normalized, [row]);
  }

  const pending: FactRow[][] = [];
  for (const byText of groups.values()) {
    for (const group of byText.values()) {
      if (group.length > 1) pending.push(group);
    }
  }
  if (pending.length === 0) return;

  const merge = db.transaction(() => {
    for (const group of pending) {
      group.sort(oldestFirst);
      const keeper = group[0];
      if (!keeper) continue;
      const extras = group.slice(1);
      if (keeper.occurrence_time == null) {
        const filled = extras.find((row) => row.occurrence_time != null);
        if (filled?.occurrence_time) {
          db.query(
            `UPDATE facts
             SET occurrence_time = ?
             WHERE id = ? AND bank_id = ? AND occurrence_time IS NULL`,
          ).run(filled.occurrence_time, keeper.id, keeper.bank_id);
        }
      }
      for (const extra of extras) {
        moveMentions(db, keeper, extra);
        db.query("DELETE FROM facts WHERE id = ? AND bank_id = ?").run(extra.id, extra.bank_id);
      }
    }
  });
  merge();
}

function oldestFirst(left: FactRow, right: FactRow): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;
  if (left.mentioned_at !== right.mentioned_at) return left.mentioned_at < right.mentioned_at ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

function moveMentions(db: Database, keeper: FactRow, extra: FactRow): void {
  const edges = db
    .query(
      `SELECT id, entity_id
       FROM edges
       WHERE bank_id = ? AND edge_type = 'mentions' AND fact_id = ?`,
    )
    .all(extra.bank_id, extra.id) as Array<{ id: string; entity_id: string }>;
  const existing = db.query(
    `SELECT 1 AS ok
     FROM edges
     WHERE bank_id = ? AND edge_type = 'mentions' AND fact_id = ? AND entity_id = ?`,
  );
  const update = db.query("UPDATE edges SET fact_id = ? WHERE id = ? AND bank_id = ?");
  const remove = db.query("DELETE FROM edges WHERE id = ? AND bank_id = ?");
  for (const edge of edges) {
    const taken = existing.get(keeper.bank_id, keeper.id, edge.entity_id);
    if (taken) remove.run(edge.id, extra.bank_id);
    else update.run(keeper.id, edge.id, extra.bank_id);
  }
}
