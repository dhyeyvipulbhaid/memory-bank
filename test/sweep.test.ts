import { afterEach, expect, test } from "bun:test";
import {
  createFakeEmbedder,
  createFakeReflector,
  openBank,
} from "../src/index.ts";
import { readRows, tempDbPath } from "./helpers.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function dbPath(): string {
  const created = tempDbPath();
  cleanups.push(created.cleanup);
  return created.path;
}

const KEPT = [
  "Maya does not have a preference for morning meetings.",
  "Maya visited Wikipedia yesterday.",
  "I don't like morning meetings.",
];

const JUNK = [
  {
    text: "The assistant does not have specific information about a person named Pepper.",
    reason: "knowledge-gap",
  },
  {
    text: "The assistant redirected the user to a search page for Pepper.",
    reason: "session-narration",
  },
  {
    text: "The assistant is unable to provide information about Pepper due to restrictions.",
    reason: "inability",
  },
  { text: "unknown", reason: "unknown" },
  { text: "...", reason: "empty" },
];

async function seed() {
  const path = dbPath();
  const bank = openBank(path, {
    embedder: createFakeEmbedder(() => [1, 0, 0]),
    reflector: createFakeReflector((input) => [
      {
        text: "Only the junk fact.",
        confidence: 0.4,
        sourceFactIds: input.facts.map((fact) => fact.id),
      },
    ]),
  });
  const maya = await bank.remember({
    text: KEPT[0]!,
    entities: [{ name: "Maya", type: "person" }],
    mentionedAt: "2024-01-01T00:00:00.000Z",
  });
  await bank.remember({
    text: KEPT[1]!,
    entities: [{ name: "Maya", type: "person" }],
    mentionedAt: "2024-01-02T00:00:00.000Z",
  });
  await bank.remember({
    text: KEPT[2]!,
    mentionedAt: "2024-01-03T00:00:00.000Z",
  });
  const pepper = await bank.remember({
    text: JUNK[0]!.text,
    entities: [{ name: "Pepper", type: "person" }],
  });
  for (const item of JUNK.slice(1)) {
    await bank.remember({ text: item.text, entities: [{ name: "Pepper", type: "person" }] });
  }
  await bank.reflect({ query: "Pepper" });
  const keptObservation = openBank(path, {
    reflector: createFakeReflector((input) => [
      {
        text: "Maya skips mornings.",
        confidence: 0.6,
        sourceFactIds: input.facts.map((fact) => fact.id),
      },
    ]),
  });
  await keptObservation.reflect({ query: "Maya" });
  keptObservation.close();
  return { path, bank, mayaId: maya.id, pepperId: pepper.id };
}

test("dry run lists only junk and does not delete", async () => {
  const { path, bank } = await seed();
  const preview = bank.sweepJunk();
  expect(preview.dryRun).toBe(true);
  expect(preview.deleted).toBe(0);
  expect(preview.candidates.map((item) => item.reason).sort()).toEqual(
    JUNK.map((item) => item.reason).sort(),
  );
  expect(preview.candidates.map((item) => item.text).sort()).toEqual(JUNK.map((item) => item.text).sort());
  expect(preview.candidates.some((item) => KEPT.includes(item.text))).toBe(false);
  expect(readRows(path, "SELECT id FROM facts")).toHaveLength(KEPT.length + JUNK.length);
  bank.close();
});

test("apply deletes only junk and cascades links, orphan entities, and lone observations", async () => {
  const { path, bank } = await seed();
  const applied = bank.sweepJunk({ dryRun: false });
  expect(applied.dryRun).toBe(false);
  expect(applied.deleted).toBe(JUNK.length);
  const remaining = readRows<{ text: string }>(path, "SELECT text FROM facts ORDER BY text");
  expect(remaining.map((row) => row.text).sort()).toEqual([...KEPT].sort());
  const entities = readRows<{ canonical_name: string }>(
    path,
    "SELECT canonical_name FROM entities ORDER BY canonical_name",
  );
  expect(entities.map((row) => row.canonical_name)).toEqual(["Maya"]);
  const observations = readRows<{ text: string }>(path, "SELECT text FROM observations");
  expect(observations.map((row) => row.text)).toEqual(["Maya skips mornings."]);
  expect(applied.removedEntityIds.length).toBeGreaterThan(0);
  expect(applied.removedObservationIds.length).toBeGreaterThan(0);

  const again = bank.sweepJunk({ dryRun: false });
  expect(again.candidates).toEqual([]);
  expect(again.deleted).toBe(0);
  bank.close();
});

test("listFacts pages and filters, updateFact re-embeds and folds duplicates", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    embedder: createFakeEmbedder((text) => (text.includes("updated") ? [0, 1, 0] : [1, 0, 0])),
  });
  await bank.remember({
    text: "Maya paints on Sundays.",
    entities: [{ name: "Maya", type: "person" }],
    mentionedAt: "2024-03-01T00:00:00.000Z",
  });
  const middle = await bank.remember({
    text: "Nia keeps a red notebook.",
    entities: [{ name: "Nia", type: "person" }],
    mentionedAt: "2024-03-02T00:00:00.000Z",
  });
  await bank.remember({
    text: "The archive holds the city maps.",
    mentionedAt: "2024-03-03T00:00:00.000Z",
  });

  const page = bank.listFacts({ limit: 1, offset: 1 });
  expect(page.total).toBe(3);
  expect(page.facts.map((fact) => fact.text)).toEqual(["Nia keeps a red notebook."]);

  const maya = bank.listFacts({ limit: 10, entity: "Maya" });
  expect(maya.facts.map((fact) => fact.text)).toEqual(["Maya paints on Sundays."]);

  const updated = await bank.updateFact(middle.id, "Nia keeps an updated notebook.");
  expect(updated.mergedIntoExisting).toBe(false);
  expect(updated.fact.text).toBe("Nia keeps an updated notebook.");
  const vector = readRows<{ embedding_dim: number | null }>(
    path,
    "SELECT embedding_dim FROM facts WHERE id = ?",
    middle.id,
  );
  expect(vector[0]?.embedding_dim).toBe(3);

  const folded = await bank.updateFact(middle.id, "Maya paints on Sundays.");
  expect(folded.mergedIntoExisting).toBe(true);
  expect(folded.fact.text).toBe("Maya paints on Sundays.");
  expect(readRows(path, "SELECT id FROM facts")).toHaveLength(2);
  bank.close();
});

test("forgetMany removes several facts in one call", async () => {
  const path = dbPath();
  const bank = openBank(path);
  const first = await bank.remember({ text: "One fact stays out." });
  const second = await bank.remember({ text: "Two goes away." });
  const third = await bank.remember({ text: "Three goes away." });
  const removed = bank.forgetMany([second.id, third.id]);
  expect(removed.removedFactIds.sort()).toEqual([second.id, third.id].sort());
  const left = readRows<{ id: string }>(path, "SELECT id FROM facts");
  expect(left.map((row) => row.id)).toEqual([first.id]);
  bank.close();
});
