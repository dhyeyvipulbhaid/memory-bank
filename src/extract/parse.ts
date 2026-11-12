import { ExtractionFailedError } from "../errors.ts";

/** Drop model reasoning blocks before JSON is parsed. A thinking field is never read. */
export function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function parseModelPayload(payload: unknown): unknown[] {
  const content = readMessageContent(payload);
  const stripped = stripThinkBlocks(content);
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new ExtractionFailedError("Extractor did not return a JSON object. Nothing was written.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch (error) {
    throw new ExtractionFailedError("Extractor returned invalid JSON. Nothing was written.", {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { facts?: unknown }).facts)) {
    throw new ExtractionFailedError("Extractor JSON must contain a facts array. Nothing was written.");
  }
  return (parsed as { facts: unknown[] }).facts;
}

function readMessageContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new ExtractionFailedError("Ollama response was empty. Nothing was written.");
  }
  const message = (payload as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    throw new ExtractionFailedError("Ollama response did not include a message. Nothing was written.");
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new ExtractionFailedError("Ollama response did not include message content. Nothing was written.");
  }
  return content;
}
