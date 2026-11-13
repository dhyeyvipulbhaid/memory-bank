import { afterEach, expect, test } from "bun:test";
import { createOllamaEmbedder, openBank } from "../src/index.ts";
import { meaningfulTokens } from "../src/tokens.ts";
import { tempDbPath } from "./helpers.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const CANINE = "The canine companion enjoys chasing spherical toys.";
const BINDER = "Quarterly revenue is filed in the blue binder.";
const PARAPHRASE = "dog plays fetch";

test.skipIf(process.env.MEMORY_BANK_OLLAMA_TEST !== "1")(
  "local nomic-embed-text ranks a paraphrase with no shared keywords first",
  async () => {
    const shared = meaningfulTokens(CANINE).filter((token) =>
      new Set(meaningfulTokens(PARAPHRASE)).has(token),
    );
    expect(shared).toEqual([]);

    const created = tempDbPath();
    cleanups.push(created.cleanup);
    const bank = openBank(created.path, {
      embedder: createOllamaEmbedder({ timeoutMs: 120_000 }),
    });
    await bank.remember({ text: BINDER });
    await bank.remember({ text: CANINE });

    const keyword = await bank.recall({ query: PARAPHRASE, tokenBudget: 400 });
    expect(keyword.facts).toEqual([]);

    const semantic = await bank.semanticSearch({
      query: PARAPHRASE,
      tokenBudget: 400,
      limit: 2,
    });
    expect(semantic.facts[0]?.text).toBe(CANINE);
    expect(semantic.facts[0]?.score).toBeGreaterThan(0);

    const hybrid = await bank.hybridRecall({
      query: PARAPHRASE,
      tokenBudget: 400,
    });
    expect(hybrid.facts[0]?.text).toBe(CANINE);
    expect(hybrid.facts[0]?.breakdown.vector).toBeGreaterThan(0);
    expect(hybrid.facts[0]?.breakdown.keyword).toBe(0);
    bank.close();
  },
);
