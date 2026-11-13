import { expect, test } from "bun:test";
import { EmbedderUnavailableError, createOllamaEmbedder } from "../src/index.ts";

test("the ollama embedder posts to /api/embed and reads the vector", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  const embedder = createOllamaEmbedder({
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ embeddings: [[0.25, -0.5, 1]] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const vector = await embedder.embed("where the dog plays");
  expect(embedder.model).toBe("nomic-embed-text");
  expect(requestUrl).toBe("http://127.0.0.1:11434/api/embed");
  expect(requestBody).toEqual({ model: "nomic-embed-text", input: "where the dog plays" });
  expect(vector).toEqual([0.25, -0.5, 1]);
});

test("model and host can be changed", async () => {
  let requestUrl = "";
  const embedder = createOllamaEmbedder({
    model: "custom-embed",
    host: "http://127.0.0.1:11434/",
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe("custom-embed");
      return new Response(JSON.stringify({ embedding: [0.5, 0.5] }), { status: 200 });
    },
  });

  expect(embedder.model).toBe("custom-embed");
  expect(await embedder.embed("hello")).toEqual([0.5, 0.5]);
  expect(requestUrl).toBe("http://127.0.0.1:11434/api/embed");
});

test("a missing /api/embed falls back to /api/embeddings", async () => {
  const urls: string[] = [];
  const embedder = createOllamaEmbedder({
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      if (String(url).endsWith("/api/embed")) {
        return new Response("not found", { status: 404 });
      }
      const body = JSON.parse(String(init?.body)) as { model: string; prompt: string };
      expect(body).toEqual({ model: "nomic-embed-text", prompt: "hello" });
      return new Response(JSON.stringify({ embedding: [1, 0] }), { status: 200 });
    },
  });

  expect(await embedder.embed("hello")).toEqual([1, 0]);
  expect(urls).toEqual([
    "http://127.0.0.1:11434/api/embed",
    "http://127.0.0.1:11434/api/embeddings",
  ]);
});

test("an unreachable embed server throws EmbedderUnavailableError", async () => {
  const embedder = createOllamaEmbedder({
    host: "http://127.0.0.1:9",
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  await expect(embedder.embed("hello")).rejects.toBeInstanceOf(EmbedderUnavailableError);
});

test("an HTTP error from the embed server throws EmbedderUnavailableError", async () => {
  const embedder = createOllamaEmbedder({
    fetchImpl: async () => new Response(JSON.stringify({ error: "model not found" }), { status: 500 }),
  });
  let error: unknown;
  try {
    await embedder.embed("hello");
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(EmbedderUnavailableError);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw error;
  expect(error.message.toLowerCase()).toContain("ollama");
});
