#!/usr/bin/env bun
import { createOllamaExtractor, openBank, type EntityType, type MemoryBank } from "./index.ts";
import { ENTITY_TYPES } from "./types.ts";

const USAGE = `memory-bank — local knowledge-graph memory

Usage:
  memory-bank retain --db <file> --content <text> [--context <text>] [--speaker <name>] [--mentioned-at <iso>] [--bank <id>] [--model <name>] [--host <url>] [--timeout-ms <n>]
  memory-bank remember --db <file> --text <text> [--kind world|experience] [--entities Name:type,...] [--occurrence-time <iso>] [--mentioned-at <iso>] [--bank <id>]
  memory-bank recall --db <file> --query <text> --token-budget <n> [--bank <id>]

retain calls a local Ollama server (default model qwen3:8b at 127.0.0.1:11434).
remember and recall do not use a model. The SQLite file is plain local data.
`;

export async function main(argv: string[]): Promise<number> {
  let bank: MemoryBank | undefined;
  try {
    const { command, flags } = parseArgs(argv);
    if (!command || command === "help" || command === "--help" || command === "-h") {
      console.error(USAGE);
      return 1;
    }
    if (command !== "retain" && command !== "remember" && command !== "recall") {
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
    }

    const db = required(flags, "db");
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
    } else {
      const result = await bank.recall({
        query: required(flags, "query"),
        tokenBudget: requireNumber(flags, "token-budget"),
      });
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
