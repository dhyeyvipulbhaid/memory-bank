import type { FetchLike } from "./extract/ollama.ts";
import { EmbedderUnavailableError } from "./errors.ts";
import type { Embedder, VectorHit, VectorRanker } from "./types.ts";

export interface OllamaEmbedderOptions {
  /** Defaults to nomic-embed-text. */
  model?: string;
  /** Ollama base URL. Defaults to http://127.0.0.1:11434. */
  host?: string;
  /** Override for tests. Production calls use global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export type FakeEmbed = (text: string) => readonly number[] | Promise<readonly number[]>;

const DEFAULT_EMBED_MODEL = "nomic-embed-text";
const DEFAULT_HOST = "http://127.0.0.1:11434";

export function createFakeEmbedder(embed: FakeEmbed, options?: { model?: string }): Embedder {
  const model = options?.model?.trim() || "fake";
  return { model, embed };
}

export function createOllamaEmbedder(options: OllamaEmbedderOptions = {}): Embedder {
  const model = options.model?.trim() || DEFAULT_EMBED_MODEL;
  const host = (options.host ?? DEFAULT_HOST).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    model,
    async embed(text) {
      const primary = await postJson(fetchImpl, host, `${host}/api/embed`, { model, input: text }, timeoutMs);
      if (primary.ok) return requireVector(primary.payload, host);
      // Older Ollama builds expose only /api/embeddings. A missing model is also 404,
      // and the second call reports that.
      if (primary.status === 404) {
        const legacy = await postJson(
          fetchImpl,
          host,
          `${host}/api/embeddings`,
          { model, prompt: text },
          timeoutMs,
        );
        if (legacy.ok) return requireVector(legacy.payload, host);
        throw httpFailure(host, legacy.status);
      }
      throw httpFailure(host, primary.status);
    },
  };
}

/** Little-endian float32, the form stored in the facts.embedding blob. */
export function encodeEmbedding(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) {
    view.setFloat32(index * 4, values[index] ?? 0, true);
  }
  return bytes;
}

export function decodeEmbedding(bytes: Uint8Array, dim: number): Float32Array | null {
  if (!Number.isInteger(dim) || dim <= 0 || bytes.byteLength !== dim * 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(dim);
  for (let index = 0; index < dim; index++) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) return null;
    vector[index] = value;
  }
  return vector;
}

export function prepareEmbedding(
  values: readonly number[],
): { dim: number; bytes: Uint8Array; vector: Float32Array } | null {
  if (values.length === 0) return null;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
  }
  const bytes = encodeEmbedding(values);
  const vector = decodeEmbedding(bytes, values.length);
  if (!vector) return null;
  return { dim: values.length, bytes, vector };
}

function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const magnitude = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (magnitude === 0) return 0;
  return dot / magnitude;
}

/** Brute-force cosine. A later index only has to implement VectorRanker. */
export function createBruteForceCosineRanker(): VectorRanker {
  return {
    rank(query, points) {
      const hits: VectorHit[] = [];
      for (const point of points) {
        const score = cosineSimilarity(query, point.vector);
        if (score > 0) hits.push({ id: point.id, score });
      }
      hits.sort((left, right) => right.score - left.score);
      return hits;
    },
  };
}

export function asEmbeddingBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  return null;
}

async function postJson(
  fetchImpl: FetchLike,
  host: string,
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ ok: true; payload: unknown } | { ok: false; status: number; payload: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new EmbedderUnavailableError(
      `Ollama is not reachable at ${host}. The fact was not embedded.`,
      { cause: error },
    );
  }
  const payload = await readJson(response);
  if (!response.ok) return { ok: false, status: response.status, payload };
  return { ok: true, payload };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function requireVector(payload: unknown, host: string): number[] {
  const vector = vectorFromPayload(payload);
  if (!vector) {
    throw new EmbedderUnavailableError(`Ollama at ${host} did not return an embedding vector.`);
  }
  return vector;
}

function vectorFromPayload(payload: unknown): number[] | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const batch = record.embeddings;
  if (Array.isArray(batch) && batch.length > 0) return finiteNumbers(batch[0]);
  return finiteNumbers(record.embedding);
}

function finiteNumbers(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    numbers.push(item);
  }
  return numbers;
}

function httpFailure(host: string, status: number): EmbedderUnavailableError {
  return new EmbedderUnavailableError(
    `Ollama at ${host} returned HTTP ${status}. The fact was not embedded.`,
  );
}
