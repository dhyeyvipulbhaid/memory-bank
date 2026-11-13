import { stripThinkBlocks } from "./extract/parse.ts";
import type { FetchLike } from "./extract/ollama.ts";
import { ReflectFailedError, ReflectorUnavailableError } from "./errors.ts";
import type { ObservationDraft, Reflector, ReflectRequest } from "./types.ts";

export interface OllamaReflectorOptions {
  /** Chat model. Defaults to qwen3:8b. */
  model?: string;
  /** Ollama base URL. Defaults to http://127.0.0.1:11434. */
  host?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export type FakeReflect = (input: ReflectRequest) => ObservationDraft[] | Promise<ObservationDraft[]>;

const DEFAULT_MODEL = "qwen3:8b";
const DEFAULT_HOST = "http://127.0.0.1:11434";
/** First load of a local chat model often exceeds a short client timeout. */
const DEFAULT_TIMEOUT_MS = 120_000;

const REFLECT_SYSTEM = `You write durable observations about the topic from the facts listed.
Reply with JSON only:
{"observations":[{"text":"...","confidence":0.0,"sourceFactIds":["..."]}]}
Quality:
- One observation per distinct pattern. Do not restate one pattern in different words.
- Cite at least two facts. A single fact is not an observation.
- State the pattern directly. No hedging and no words such as suggesting, indicating, seems, might, or possibly.
- Do not restate a single fact in new words.
- Do not write meta comments such as "X is separate from Y" or "mentioned in the context of".
- Use only facts about the topic. Ignore the rest.
- confidence is from 0 to 1. At most 5 observations.
- Do not say the assistant lacks knowledge or just did something in this chat.`;

export function createFakeReflector(reflect: FakeReflect): Reflector {
  return { reflect };
}

export function createOllamaReflector(options: OllamaReflectorOptions = {}): Reflector {
  const model = options.model?.trim() || DEFAULT_MODEL;
  const host = (options.host ?? DEFAULT_HOST).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async reflect(input) {
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
              { role: "system", content: REFLECT_SYSTEM },
              { role: "user", content: reflectUserMessage(input) },
            ],
          }),
        });
      } catch (error) {
        throw new ReflectorUnavailableError(
          `Ollama is not reachable at ${host}. reflect did not write anything.`,
          { cause: error },
        );
      }
      if (!response.ok) {
        throw new ReflectorUnavailableError(
          `Ollama at ${host} returned HTTP ${response.status}. reflect did not write anything.`,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new ReflectorUnavailableError(`Ollama at ${host} did not return a response body.`, {
          cause: error,
        });
      }
      return readObservations(payload);
    },
  };
}

function reflectUserMessage(input: ReflectRequest): string {
  const topic = input.topic?.trim() ? `Topic: ${input.topic.trim()}\n\n` : "";
  const lines = input.facts.map(
    (fact) => `${fact.id} | ${fact.kind} | ${fact.mentionedAt} | ${fact.text}`,
  );
  return `${topic}Facts:\n${lines.join("\n")}`;
}

function readObservations(payload: unknown): ObservationDraft[] {
  const content = readContent(payload);
  const stripped = stripThinkBlocks(content);
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new ReflectFailedError("Reflector did not return a JSON object. Nothing was written.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch (error) {
    throw new ReflectFailedError("Reflector returned invalid JSON. Nothing was written.", { cause: error });
  }
  const list =
    parsed && typeof parsed === "object" ? (parsed as { observations?: unknown }).observations : undefined;
  if (!Array.isArray(list)) {
    throw new ReflectFailedError("Reflector JSON must contain an observations array. Nothing was written.");
  }
  return list.map(readDraft);
}

function readDraft(value: unknown): ObservationDraft {
  if (!value || typeof value !== "object") {
    return { text: "", confidence: Number.NaN, sourceFactIds: [] };
  }
  const record = value as { text?: unknown; confidence?: unknown; sourceFactIds?: unknown };
  const text = typeof record.text === "string" ? record.text : "";
  const confidence = typeof record.confidence === "number" ? record.confidence : Number.NaN;
  const sourceFactIds = Array.isArray(record.sourceFactIds)
    ? record.sourceFactIds.filter((id): id is string => typeof id === "string")
    : [];
  return { text, confidence, sourceFactIds };
}

function readContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new ReflectFailedError("Ollama reflect response was empty. Nothing was written.");
  }
  const message = (payload as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    throw new ReflectFailedError("Ollama reflect response did not include a message. Nothing was written.");
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new ReflectFailedError("Ollama reflect response did not include message content. Nothing was written.");
  }
  return content;
}
