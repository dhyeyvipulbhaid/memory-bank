import { afterEach, expect, test } from "bun:test";
import { createFakeEmbedder, createFakeReflector, openBank } from "../src/index.ts";
import { tempDbPath } from "./helpers.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function dbPath(): string {
  const created = tempDbPath();
  cleanups.push(created.cleanup);
  return created.path;
}

test("an empty bank has an empty graph", () => {
  const bank = openBank(dbPath());
  expect(bank.graphSnapshot()).toEqual({ nodes: [], edges: [] });
  bank.close();
});

test("the snapshot types semantic, temporal, entity, and derived edges", async () => {
  const path = dbPath();
  const bank = openBank(path, {
    embedder: createFakeEmbedder((text) => {
      if (text.startsWith("Maya")) return [1, 0, 0];
      if (text.startsWith("Orbit")) return [0.96, 0.28, 0];
      return [0, 1, 0];
    }),
    reflector: createFakeReflector((input) => [
      {
        text: "Maya and Orbit keep showing up together.",
        confidence: 0.8,
        sourceFactIds: input.facts.map((fact) => fact.id),
      },
    ]),
  });
  const now = "2026-11-13T12:00:00.000Z";
  const maya = await bank.remember({
    text: "Maya opened the launch review.",
    entities: [{ name: "Maya", type: "person" }],
    mentionedAt: now,
  });
  const orbit = await bank.remember({
    text: "Orbit joined Maya at the launch review.",
    entities: [
      { name: "Maya", type: "person" },
      { name: "Orbit", type: "org" },
    ],
    mentionedAt: "2026-11-13T18:00:00.000Z",
  });
  await bank.remember({
    text: "The archive moved cities last year.",
    entities: [{ name: "Archive", type: "place" }],
    mentionedAt: "2024-01-01T00:00:00.000Z",
  });
  await bank.reflect({ entity: "Maya" });

  const snapshot = bank.graphSnapshot({ now, minSimilarity: 0.9 });
  expect(snapshot.nodes.length).toBeGreaterThanOrEqual(3);
  const observation = snapshot.nodes.find((node) => node.derived);
  expect(observation?.kind).toBe("observation");
  expect(observation?.sourceFactCount).toBeGreaterThanOrEqual(2);
  expect(observation?.label.length).toBeLessThanOrEqual(80);
  expect(observation?.recency).toBeGreaterThan(0);
  expect(observation?.recency).toBeLessThanOrEqual(1);

  const types = new Set(snapshot.edges.map((edge) => edge.type));
  expect(types.has("entity")).toBe(true);
  expect(types.has("semantic")).toBe(true);
  expect(types.has("temporal")).toBe(true);
  expect(types.has("derived")).toBe(true);

  const pair = [maya.id, orbit.id].sort();
  expect(
    snapshot.edges.some(
      (edge) =>
        edge.type === "entity" &&
        edge.source === pair[0] &&
        edge.target === pair[1],
    ),
  ).toBe(true);
  expect(
    snapshot.edges.some(
      (edge) => edge.type === "derived" && edge.source === observation?.id && edge.target === maya.id,
    ),
  ).toBe(true);

  const hidden = bank.graphSnapshot({ includeObservations: false, now });
  expect(hidden.nodes.some((node) => node.derived)).toBe(false);
  expect(hidden.edges.some((edge) => edge.type === "derived")).toBe(false);
  bank.close();
});

test("the node cap drops the older facts", async () => {
  const bank = openBank(dbPath());
  await bank.remember({ text: "Older lighthouse note.", mentionedAt: "2020-01-01T00:00:00.000Z" });
  await bank.remember({ text: "Newer lighthouse note.", mentionedAt: "2026-11-01T00:00:00.000Z" });
  const snapshot = bank.graphSnapshot({ limit: 1, now: "2026-11-13T00:00:00.000Z" });
  expect(snapshot.nodes.map((node) => node.label)).toEqual(["Newer lighthouse note."]);
  expect(snapshot.edges).toEqual([]);
  bank.close();
});
