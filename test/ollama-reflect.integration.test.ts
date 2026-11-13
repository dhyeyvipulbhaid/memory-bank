import { afterEach, expect, test } from "bun:test";
import { createOllamaReflector, openBank } from "../src/index.ts";
import { tempDbPath } from "./helpers.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test.skipIf(process.env.MEMORY_BANK_OLLAMA_TEST !== "1")(
  "local qwen3:8b writes observations that cite the gathered facts",
  async () => {
    const created = tempDbPath();
    cleanups.push(created.cleanup);
    const bank = openBank(created.path, {
      reflector: createOllamaReflector({ model: "qwen3:8b", timeoutMs: 120_000 }),
    });
    const morning = await bank.remember({
      text: "Maya prefers morning meetings.",
      entities: [{ name: "Maya", type: "person" }],
    });
    const afternoon = await bank.remember({
      text: "Maya declined the afternoon slot.",
      entities: [{ name: "Maya", type: "person" }],
    });
    const allowed = new Set([morning.id, afternoon.id]);

    const result = await bank.reflect({ query: "Maya meetings", maxObservations: 3 });
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.observations.length).toBeLessThanOrEqual(3);
    for (const observation of result.observations) {
      expect(observation.derived).toBe(true);
      expect(observation.text.trim().length).toBeGreaterThan(0);
      expect(observation.sourceFactIds.length).toBeGreaterThan(0);
      expect(observation.sourceFactIds.every((id) => allowed.has(id))).toBe(true);
    }
    bank.close();
  },
  { timeout: 120_000 },
);
