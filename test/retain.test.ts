import { afterEach, expect, test } from "bun:test";
import {
  ExtractionFailedError,
  ExtractorUnavailableError,
  createFakeExtractor,
  openBank,
  type ExtractedFact,
  type ExtractInput,
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

const sampleFacts = [
  {
    text: "Alice Chen moved the design review to Monday.",
    kind: "world" as const,
    occurrenceTime: "2024-06-03T00:00:00.000Z",
    entities: [{ name: "Alice Chen", type: "person" as const }],
  },
  {
    text: "I wrote down the decisions from the design review.",
    kind: "experience" as const,
    occurrenceTime: null,
    entities: [{ name: "Alice Chen", type: "person" as const }],
  },
];

test("retain with a fake extractor writes facts, entities, and the original source", async () => {
  const path = dbPath();
  const seen: ExtractInput[] = [];
  const bank = openBank(path, {
    extractor: createFakeExtractor((input) => {
      seen.push(input);
      return sampleFacts;
    }),
  });

  const result = await bank.retain({
    content: "On Monday Alice Chen moved the design review. I wrote down the decisions.",
    context: "planning chat",
    speaker: "user",
    mentionedAt: "2024-06-04T15:00:00.000Z",
  });

  expect(seen).toEqual([
    {
      content: "On Monday Alice Chen moved the design review. I wrote down the decisions.",
      context: "planning chat",
      speaker: "user",
      mentionedAt: "2024-06-04T15:00:00.000Z",
    },
  ]);
  expect(result.facts).toHaveLength(2);
  expect(result.facts[0]?.kind).toBe("world");
  expect(result.facts[0]?.occurrenceTime).toBe("2024-06-03T00:00:00.000Z");
  expect(result.facts[0]?.mentionedAt).toBe("2024-06-04T15:00:00.000Z");
  expect(result.facts[1]?.kind).toBe("experience");
  expect(result.facts[0]?.entities[0]?.id).toBe(result.facts[1]?.entities[0]?.id);

  const sources = readRows<{ text: string; context: string; speaker: string }>(
    path,
    "SELECT text, context, speaker FROM sources",
  );
  expect(sources).toEqual([
    {
      text: "On Monday Alice Chen moved the design review. I wrote down the decisions.",
      context: "planning chat",
      speaker: "user",
    },
  ]);
  const edges = readRows<{ edge_type: string }>(path, "SELECT edge_type FROM edges");
  expect(edges.length).toBeGreaterThan(0);
  expect(new Set(edges.map((edge) => edge.edge_type))).toEqual(new Set(["mentions"]));
  bank.close();
});

test("retain stores at most five facts from one extraction", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    extractor: createFakeExtractor(() =>
      Array.from({ length: 8 }, (_, index) => ({
        text: `Fact number ${index + 1} about the harbor.`,
        kind: "world" as const,
        occurrenceTime: null,
        entities: [{ name: "Harbor", type: "place" as const }],
      })),
    ),
  });

  const result = await bank.retain({
    content: "A long note about the harbor that should stay coarse.",
    mentionedAt: "2024-01-01T00:00:00.000Z",
  });
  expect(result.facts).toHaveLength(5);
  const facts = readRows<{ text: string }>(path, "SELECT text FROM facts");
  expect(facts).toHaveLength(5);
  bank.close();
});

test("a failing extractor writes nothing", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    extractor: createFakeExtractor(() => {
      throw new ExtractorUnavailableError("Ollama is not reachable");
    }),
  });

  await expect(
    bank.retain({ content: "This must not be stored if extraction fails." }),
  ).rejects.toBeInstanceOf(ExtractorUnavailableError);

  expect(readRows(path, "SELECT id FROM sources")).toHaveLength(0);
  expect(readRows(path, "SELECT id FROM facts")).toHaveLength(0);
  expect(readRows(path, "SELECT id FROM entities")).toHaveLength(0);

  const manual = await bank.remember({ text: "Offline notes still save." });
  expect(manual.text).toBe("Offline notes still save.");
  bank.close();
});

test("malformed extractor output writes nothing", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    extractor: createFakeExtractor(() => [
      {
        text: "Fine fact.",
        kind: "world",
        occurrenceTime: null,
        entities: [],
      },
      {
        text: "Bad fact.",
        kind: "opinion" as "world",
        occurrenceTime: null,
        entities: [],
      },
    ]),
  });

  await expect(bank.retain({ content: "Mixed quality output." })).rejects.toBeInstanceOf(
    ExtractionFailedError,
  );
  expect(readRows(path, "SELECT id FROM facts")).toHaveLength(0);
  expect(readRows(path, "SELECT id FROM sources")).toHaveLength(0);
  bank.close();
});

const preference =
  "You: Can we move the standup? Maya: Let's do mornings, 9am works for me.";
const preferenceFact =
  "Maya agrees to move the standup to mornings and confirms 9am works for her.";

test("an undated preference keeps occurrenceTime null when the extractor copies the retain clock", async () => {
  const path = dbPath();
  const mentionedAt = "2026-11-12T22:15:00.000Z";
  const bank = openBank(path, {
    extractor: createFakeExtractor(() => [
      {
        text: preferenceFact,
        kind: "world",
        occurrenceTime: mentionedAt,
        entities: [{ name: "Maya", type: "person" }],
      },
    ]),
  });

  const result = await bank.retain({ content: preference, mentionedAt });

  expect(result.facts).toHaveLength(1);
  expect(result.facts[0]?.text).toBe(preferenceFact);
  expect(result.facts[0]?.occurrenceTime).toBeNull();
  expect(result.facts[0]?.mentionedAt).toBe(mentionedAt);
  const rows = readRows<{ occurrence_time: string | null; mentioned_at: string }>(
    path,
    "SELECT occurrence_time, mentioned_at FROM facts",
  );
  expect(rows).toEqual([{ occurrence_time: null, mentioned_at: mentionedAt }]);
  bank.close();
});

test("a preferred hour is not stored as an occurrence time", async () => {
  const path = dbPath();
  const mentionedAt = "2026-11-12T22:15:00.000Z";
  const bank = openBank(path, {
    extractor: createFakeExtractor(() => [
      {
        text: preferenceFact,
        kind: "world",
        occurrenceTime: "2026-11-12T09:00:00.000Z",
        entities: [{ name: "Maya", type: "person" }],
      },
    ]),
  });

  const result = await bank.retain({ content: preference, mentionedAt });

  expect(result.facts[0]?.occurrenceTime).toBeNull();
  expect(result.facts[0]?.mentionedAt).toBe(mentionedAt);
  bank.close();
});

test("retain stores an explicit occurrenceTime when the text names the occurrence", async () => {
  const path = dbPath();
  const mentionedAt = "2026-11-12T22:15:00.000Z";
  const occurrenceTime = "2026-11-10T09:00:00.000Z";
  const bank = openBank(path, {
    extractor: createFakeExtractor(() => [
      {
        text: "Maya and I met on 2026-11-10 at 9:00.",
        kind: "world",
        occurrenceTime,
        entities: [{ name: "Maya", type: "person" }],
      },
    ]),
  });

  const result = await bank.retain({
    content: "Maya and I met on 2026-11-10 at 9:00.",
    mentionedAt,
  });

  expect(result.facts[0]?.occurrenceTime).toBe(occurrenceTime);
  expect(result.facts[0]?.mentionedAt).toBe(mentionedAt);
  expect(result.facts[0]?.occurrenceTime).not.toBe(mentionedAt);
  const rows = readRows<{ occurrence_time: string | null }>(
    path,
    "SELECT occurrence_time FROM facts",
  );
  expect(rows[0]?.occurrence_time).toBe(occurrenceTime);
  bank.close();
});

test("a weekday or calendar day in the text keeps the extractor occurrenceTime", async () => {
  const path = dbPath();
  const mentionedAt = "2026-11-12T22:15:00.000Z";
  const tuesday = "2026-11-10T15:00:00.000Z";
  const standup = "2026-11-10T09:00:00.000Z";
  const bank = openBank(path, {
    extractor: createFakeExtractor((input) => [
      {
        text: input.content,
        kind: "world" as const,
        occurrenceTime: input.content.includes("Tuesday") ? tuesday : standup,
        entities: [{ name: "Maya", type: "person" as const }],
      },
    ]),
  });

  const met = await bank.retain({ content: "we met Tuesday", mentionedAt });
  const scheduled = await bank.retain({
    content: "the standup was on Nov 10 at 9am",
    mentionedAt,
  });

  expect(met.facts[0]?.occurrenceTime).toBe(tuesday);
  expect(scheduled.facts[0]?.occurrenceTime).toBe(standup);
  expect(met.facts[0]?.mentionedAt).toBe(mentionedAt);
  expect(scheduled.facts[0]?.mentionedAt).toBe(mentionedAt);
  bank.close();
});

test("a missing occurrenceTime stays null instead of the current clock", async () => {
  const path = dbPath();
  const before = Date.now();
  const bank = openBank(path, {
    extractor: createFakeExtractor(() => [
      {
        text: "Maya prefers morning standups.",
        kind: "world",
        entities: [{ name: "Maya", type: "person" }],
      } as ExtractedFact,
    ]),
  });

  const result = await bank.retain({
    content: "Maya: I prefer mornings for standup.",
  });
  const after = Date.now();

  expect(result.facts[0]?.occurrenceTime).toBeNull();
  const mentionedAtMs = Date.parse(result.facts[0]?.mentionedAt ?? "");
  expect(mentionedAtMs).toBeGreaterThanOrEqual(before);
  expect(mentionedAtMs).toBeLessThanOrEqual(after);
  const rows = readRows<{ occurrence_time: string | null; mentioned_at: string }>(
    path,
    "SELECT occurrence_time, mentioned_at FROM facts",
  );
  expect(rows[0]?.occurrence_time).toBeNull();
  expect(rows[0]?.mentioned_at).toBe(result.facts[0]?.mentionedAt);
  bank.close();
});
