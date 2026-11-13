import { expect, test } from "bun:test";
import { createOllamaReranker } from "../src/index.ts";

test("the ollama reranker asks for JSON ids and reads them back", async () => {
  let requestUrl = "";
  let requestBody: { model?: string; think?: boolean; format?: string } = {};
  const reranker = createOllamaReranker({
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return new Response(
        JSON.stringify({
          message: { role: "assistant", content: JSON.stringify({ ids: ["b", "a"] }) },
        }),
        { status: 200 },
      );
    },
  });

  const ids = await reranker.rerank({
    query: "beacon",
    facts: [
      { id: "a", text: "Alpha" },
      { id: "b", text: "Beta" },
    ],
  });
  expect(requestUrl).toBe("http://127.0.0.1:11434/api/chat");
  expect(requestBody.model).toBe("qwen3:8b");
  expect(requestBody.think).toBe(false);
  expect(requestBody.format).toBe("json");
  expect(ids).toEqual(["b", "a"]);
});
