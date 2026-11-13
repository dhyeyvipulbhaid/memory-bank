import { stripThinkBlocks } from "./extract/parse.ts";
import type { FetchLike } from "./extract/ollama.ts";
import { MemoryBankError } from "./errors.ts";
import type { RerankInput, Reranker } from "./types.ts";

export interface OllamaRerankerOptions {
  /** Chat model. Defaults to qwen3:8b. */
  model?: string;
  /** Ollama base URL. Defaults to http://127.0.0.1:11434. */
  host?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_MODEL = "qwen3:8b";
const DEFAULT_HOST = "http://127.0.0.1:11434";

const RERANK_SYSTEM = `You reorder memory facts for a query.
Reply with JSON only: {"ids":["..."]}
Use only the given ids. Put the most relevant id first.
Do not add facts.`;

export function createOllamaReranker(options: OllamaRerankerOptions = {}): Reranker {
  const model = options.model?.trim() || DEFAULT_MODEL;
  const host = (options.host ?? DEFAULT_HOST).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    async rerank(input) {
      if (input.facts.length === 0) return [];
      let response: Response;
      try {
        response = await fetchImpl(`${host}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            model,
            stream: false,
            think: false,
            format: "json",
            messages: [
              { role: "system", content: RERANK_SYSTEM },
              { role: "user", content: rerankUserMessage(input) },
            ],
          }),
        });
      } catch (error) {
        throw new MemoryBankError(`Ollama rerank is not reachable at ${host}.`, { cause: error });
      }
      if (!response.ok) {
        throw new MemoryBankError(`Ollama rerank at ${host} returned HTTP ${response.status}.`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new MemoryBankError("Ollama rerank did not return JSON.", { cause: error });
      }
      return readRerankIds(payload);
    },
  };
}

export function reorderByIds<T extends { id: string }>(facts: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of ids) {
    const fact = byId.get(id);
    if (!fact || seen.has(id)) continue;
    seen.add(id);
    ordered.push(fact);
  }
  for (const fact of facts) {
    if (!seen.has(fact.id)) ordered.push(fact);
  }
  return ordered;
}

function rerankUserMessage(input: RerankInput): string {
  const lines = input.facts.map((fact) => `${fact.id}: ${fact.text}`);
  return `Query: ${input.query}\n\nFacts:\n${lines.join("\n")}`;
}

function readRerankIds(payload: unknown): string[] {
  const content = readContent(payload);
  const stripped = stripThinkBlocks(content);
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end < start) throw new MemoryBankError("Ollama rerank did not return a JSON object.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch (error) {
    throw new MemoryBankError("Ollama rerank returned invalid JSON.", { cause: error });
  }
  const ids = parsed && typeof parsed === "object" ? (parsed as { ids?: unknown }).ids : undefined;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new MemoryBankError('Ollama rerank JSON must contain an "ids" array of strings.');
  }
  return ids;
}

function readContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new MemoryBankError("Ollama rerank response was empty.");
  const message = (payload as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    throw new MemoryBankError("Ollama rerank response did not include a message.");
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new MemoryBankError("Ollama rerank response did not include message content.");
  }
  return content;
}
