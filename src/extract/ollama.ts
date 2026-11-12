import { ExtractorUnavailableError } from "../errors.ts";
import type { Extractor } from "../types.ts";
import { parseModelPayload } from "./parse.ts";
import { EXTRACTION_SYSTEM_PROMPT, extractionUserMessage } from "./prompt.ts";
import { normalizeExtractedFacts } from "./validate.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OllamaExtractorOptions {
  /** Defaults to qwen3:8b. */
  model?: string;
  /** Defaults to http://127.0.0.1:11434. */
  host?: string;
  /** Override for tests. Production calls use global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_MODEL = "qwen3:8b";
const DEFAULT_HOST = "http://127.0.0.1:11434";

export function createOllamaExtractor(options: OllamaExtractorOptions = {}): Extractor {
  const model = options.model?.trim() || DEFAULT_MODEL;
  const host = (options.host ?? DEFAULT_HOST).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    async extract(input) {
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
              { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
              { role: "user", content: extractionUserMessage(input) },
            ],
          }),
        });
      } catch (error) {
        throw new ExtractorUnavailableError(
          `Ollama is not reachable at ${host}. retain did not write anything. remember and recall still work offline.`,
          { cause: error },
        );
      }

      if (!response.ok) {
        throw new ExtractorUnavailableError(
          `Ollama at ${host} returned HTTP ${response.status}. retain did not write anything.`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new ExtractorUnavailableError(
          `Ollama at ${host} did not return a response body. retain did not write anything.`,
          { cause: error },
        );
      }
      return normalizeExtractedFacts(parseModelPayload(payload));
    },
  };
}
