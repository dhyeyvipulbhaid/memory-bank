#!/usr/bin/env bun
import {
  createOllamaEmbedder,
  createOllamaExtractor,
  createOllamaReflector,
  createOllamaReranker,
  openBank,
  type EntityType,
  type MemoryBank,
} from "./index.ts";
import { ENTITY_TYPES } from "./types.ts";

const USAGE = `memory-bank — local knowledge-graph memory

Usage:
  memory-bank retain --db <file> --content <text> [--context <text>] [--speaker <name>] [--mentioned-at <iso>] [--bank <id>] [--model <name>] [--embed-model <name>] [--host <url>] [--timeout-ms <n>] [--no-embed]
  memory-bank remember --db <file> --text <text> [--kind world|experience] [--entities Name:type,...] [--occurrence-time <iso>] [--mentioned-at <iso>] [--bank <id>] [--embed-model <name>] [--host <url>] [--timeout-ms <n>] [--no-embed]
  memory-bank recall --db <file> --query <text> --token-budget <n> [--bank <id>]
  memory-bank hybrid --db <file> --query <text> --token-budget <n> [--bank <id>] [--embed-model <name>] [--host <url>] [--half-life-days <n>] [--llm-rerank] [--no-embed]
  memory-bank reflect --db <file> [--query <text>] [--entity <name>] [--topic <text>] [--since <iso>] [--until <iso>] [--max <n>] [--bank <id>] [--model <name>] [--host <url>] [--timeout-ms <n>] [--no-embed]
  memory-bank backfill --db <file> [--bank <id>] [--embed-model <name>] [--host <url>] [--timeout-ms <n>]

retain calls a local Ollama server (default chat model qwen3:8b).
remember and retain also embed with nomic-embed-text unless --no-embed is set.
If embedding fails, the fact is still stored. recall does not use a model.
hybrid fuses keyword, vector, and graph signals. It still answers if embedding is down.
reflect asks Ollama (default qwen3:8b) for observations and writes nothing if that call fails.
backfill embeds facts that have no vector yet. The SQLite file is plain local data.
`;

export async function main(argv: string[]): Promise<number> {
  let bank: MemoryBank | undefined;
  try {
    const { command, flags } = parseArgs(argv);
    if (!command || command === "help" || command === "--help" || command === "-h") {
      console.error(USAGE);
      return 1;
    }
    if (
      command !== "retain" &&
      command !== "remember" &&
      command !== "recall" &&
      command !== "backfill" &&
      command !== "hybrid" &&
      command !== "reflect"
    ) {
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
    }

    const db = required(flags, "db");
    const embed =
      command === "backfill" ||
      ((command === "hybrid" || command === "reflect") && !flags.has("no-embed")) ||
      ((command === "retain" || command === "remember") && !flags.has("no-embed"));
    bank = openBank(db, {
      bankId: flags.get("bank"),
      extractor:
        command === "retain"
          ? createOllamaExtractor({
              model: flags.get("model"),
              host: flags.get("host"),
              timeoutMs: flags.has("timeout-ms") ? requireNumber(flags, "timeout-ms") : undefined,
            })
          : undefined,
      embedder: embed
        ? createOllamaEmbedder({
            model: flags.get("embed-model"),
            host: flags.get("host"),
            timeoutMs: flags.has("timeout-ms") ? requireNumber(flags, "timeout-ms") : undefined,
          })
        : undefined,
      reranker: flags.has("llm-rerank")
        ? createOllamaReranker({
            model: flags.get("model"),
            host: flags.get("host"),
            timeoutMs: flags.has("timeout-ms") ? requireNumber(flags, "timeout-ms") : undefined,
          })
        : undefined,
      reflector:
        command === "reflect"
          ? createOllamaReflector({
              model: flags.get("model"),
              host: flags.get("host"),
              timeoutMs: flags.has("timeout-ms") ? requireNumber(flags, "timeout-ms") : undefined,
            })
          : undefined,
    });

    if (command === "retain") {
      const result = await bank.retain({
        content: required(flags, "content"),
        context: flags.get("context"),
        speaker: flags.get("speaker"),
        mentionedAt: flags.get("mentioned-at"),
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "remember") {
      const result = await bank.remember({
        text: required(flags, "text"),
        kind: parseKind(flags.get("kind")),
        entities: parseEntities(flags.get("entities")),
        occurrenceTime: flags.get("occurrence-time"),
        mentionedAt: flags.get("mentioned-at"),
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "recall") {
      const result = await bank.recall({
        query: required(flags, "query"),
        tokenBudget: requireNumber(flags, "token-budget"),
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "hybrid") {
      const result = await bank.hybridRecall({
        query: required(flags, "query"),
        tokenBudget: requireNumber(flags, "token-budget"),
        halfLifeDays: flags.has("half-life-days") ? requireNumber(flags, "half-life-days") : undefined,
        llmRerank: flags.has("llm-rerank"),
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "reflect") {
      const result = await bank.reflect({
        query: flags.get("query"),
        entity: flags.get("entity"),
        topic: flags.get("topic"),
        since: flags.get("since"),
        until: flags.get("until"),
        maxObservations: flags.has("max") ? requireNumber(flags, "max") : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
    } else {
      const result = await bank.backfillEmbeddings();
      console.log(JSON.stringify(result, null, 2));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  } finally {
    bank?.close();
  }
}

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index] ?? "";
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const key = token.slice(2);
    if (key === "no-embed" || key === "llm-rerank") {
      flags.set(key, "true");
      continue;
    }
    const value = rest[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    flags.set(key, value);
    index += 1;
  }
  return { command: command ?? "", flags };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value == null || value.trim() === "") throw new Error(`Missing --${name}`);
  return value;
}

function requireNumber(flags: Map<string, string>, name: string): number {
  const raw = required(flags, name);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

function parseKind(value: string | undefined): "world" | "experience" | undefined {
  if (value == null) return undefined;
  if (value !== "world" && value !== "experience") {
    throw new Error('kind must be "world" or "experience".');
  }
  return value;
}

function parseEntities(value: string | undefined): Array<{ name: string; type: EntityType }> | undefined {
  if (value == null || value.trim() === "") return undefined;
  return value.split(",").map((part) => {
    const trimmed = part.trim();
    const colon = trimmed.lastIndexOf(":");
    if (colon <= 0) throw new Error(`Entity must look like Name:type (${trimmed})`);
    const name = trimmed.slice(0, colon).trim();
    const type = trimmed.slice(colon + 1).trim();
    if (!name) throw new Error(`Entity must look like Name:type (${trimmed})`);
    if (!ENTITY_TYPES.includes(type as EntityType)) {
      throw new Error(`Entity type must be one of: ${ENTITY_TYPES.join(", ")}.`);
    }
    return { name, type: type as EntityType };
  });
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
