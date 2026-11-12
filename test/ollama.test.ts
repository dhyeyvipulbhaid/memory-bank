import { afterEach, expect, test } from "bun:test";
import {
  ExtractionFailedError,
  ExtractorUnavailableError,
  createOllamaExtractor,
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

const factJson = JSON.stringify({
  facts: [
    {
      text: "Nia keeps a red notebook.",
      kind: "world",
      occurrenceTime: null,
      entities: [{ name: "Nia", type: "person" }],
    },
  ],
});

test("the ollama extractor asks for JSON with thinking disabled and ignores think output", async () => {
  const path = dbPath();
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        thinking: "ignore this field",
        message: {
          role: "assistant",
          content: `<think>hidden chain of thought</think>\n${factJson}`,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const bank = openBank(path, {
    extractor: createOllamaExtractor({ fetchImpl }),
  });
  const result = await bank.retain({
    content: "Nia keeps a red notebook in her bag.",
    mentionedAt: "2024-07-01T00:00:00.000Z",
    speaker: "user",
  });

  expect(requestUrl).toBe("http://127.0.0.1:11434/api/chat");
  expect(requestBody.model).toBe("qwen3:8b");
  expect(requestBody.think).toBe(false);
  expect(requestBody.stream).toBe(false);
  expect(requestBody.format).toBe("json");
  expect(result.facts).toHaveLength(1);
  expect(result.facts[0]?.text).toBe("Nia keeps a red notebook.");
  expect(result.facts[0]?.entities[0]?.name).toBe("Nia");
  expect(result.facts[0]?.text.includes("hidden")).toBe(false);
  expect(result.facts[0]?.text.includes("ignore this field")).toBe(false);
  bank.close();
});

test("model and host can be changed", async () => {
  let requestUrl = "";
  let model = "";
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    model = (JSON.parse(String(init?.body)) as { model: string }).model;
    return new Response(
      JSON.stringify({ message: { role: "assistant", content: factJson } }),
      { status: 200 },
    );
  };
  const bank = openBank(dbPath(), {
    extractor: createOllamaExtractor({
      model: "qwen3:4b",
      host: "http://127.0.0.1:11435/",
      fetchImpl,
    }),
  });
  await bank.retain({ content: "Nia keeps a red notebook.", mentionedAt: "2024-07-01T00:00:00.000Z" });
  expect(requestUrl).toBe("http://127.0.0.1:11435/api/chat");
  expect(model).toBe("qwen3:4b");
  bank.close();
});

test("when ollama cannot be reached, retain writes nothing and recall still works", async () => {
  const path = dbPath();
  const fetchImpl = async (): Promise<Response> => {
    throw new TypeError("connect ECONNREFUSED 127.0.0.1:11434");
  };
  const bank = openBank(path, { extractor: createOllamaExtractor({ fetchImpl }) });
  await bank.remember({
    text: "The ferry still runs on Sundays.",
    entities: [{ name: "Ferry", type: "product" }],
  });

  await expect(
    bank.retain({ content: "A new note that must not be saved." }),
  ).rejects.toBeInstanceOf(ExtractorUnavailableError);

  const sources = readRows<{ text: string }>(path, "SELECT text FROM sources");
  expect(sources.map((row) => row.text)).toEqual(["The ferry still runs on Sundays."]);
  const recalled = await bank.recall({ query: "ferry Sundays", tokenBudget: 100 });
  expect(recalled.facts).toHaveLength(1);
  bank.close();
});

test("a non-JSON ollama body fails the retain and writes nothing", async () => {
  const path = dbPath();
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify({ message: { role: "assistant", content: "I am not json" } }), {
      status: 200,
    });
  const bank = openBank(path, { extractor: createOllamaExtractor({ fetchImpl }) });
  await expect(bank.retain({ content: "Nothing durable here." })).rejects.toBeInstanceOf(
    ExtractionFailedError,
  );
  expect(readRows(path, "SELECT id FROM sources")).toHaveLength(0);
  expect(readRows(path, "SELECT id FROM facts")).toHaveLength(0);
  bank.close();
});

test("an http error from ollama does not write", async () => {
  const path = dbPath();
  const fetchImpl = async (): Promise<Response> => new Response("busy", { status: 503 });
  const bank = openBank(path, { extractor: createOllamaExtractor({ fetchImpl }) });
  await expect(bank.retain({ content: "Try again later." })).rejects.toBeInstanceOf(
    ExtractorUnavailableError,
  );
  expect(readRows(path, "SELECT id FROM facts")).toHaveLength(0);
  bank.close();
});
