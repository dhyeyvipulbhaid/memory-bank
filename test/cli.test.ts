import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-bank-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "src/cli.ts", ...args],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("remember and recall work from the CLI without a model", async () => {
  const db = join(tempDir(), "memory.sqlite");
  const saved = await run([
    "remember",
    "--no-embed",
    "--db",
    db,
    "--text",
    "Nia keeps a red notebook.",
    "--entities",
    "Nia:person",
    "--kind",
    "world",
    "--mentioned-at",
    "2024-08-01T00:00:00.000Z",
  ]);
  expect(saved.code).toBe(0);
  expect(JSON.parse(saved.stdout).text).toBe("Nia keeps a red notebook.");

  const recalled = await run([
    "recall",
    "--db",
    db,
    "--query",
    "Nia notebook",
    "--token-budget",
    "40",
  ]);
  expect(recalled.code).toBe(0);
  const body = JSON.parse(recalled.stdout) as { facts: Array<{ text: string }>; tokensUsed: number };
  expect(body.facts.map((fact) => fact.text)).toEqual(["Nia keeps a red notebook."]);
  expect(body.tokensUsed).toBeLessThanOrEqual(40);
});

test("retain against a closed port fails and does not create facts", async () => {
  const db = join(tempDir(), "memory.sqlite");
  const result = await run([
    "retain",
    "--db",
    db,
    "--content",
    "This note should not be stored.",
    "--host",
    "http://127.0.0.1:9",
    "--timeout-ms",
    "500",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr.toLowerCase()).toContain("ollama");

  const sqlite = new Database(db, { readonly: true });
  try {
    const facts = sqlite.query("SELECT id FROM facts").all();
    expect(facts).toHaveLength(0);
  } finally {
    sqlite.close();
  }
});

test("remembering the same text twice from the CLI stores one fact", async () => {
  const db = join(tempDir(), "memory.sqlite");
  const first = await run([
    "remember",
    "--no-embed",
    "--db",
    db,
    "--text",
    "Maya prefers morning meetings",
    "--entities",
    "Maya:person",
    "--mentioned-at",
    "2024-01-01T00:00:00.000Z",
  ]);
  const second = await run([
    "remember",
    "--no-embed",
    "--db",
    db,
    "--text",
    "  maya   prefers morning meetings ",
    "--entities",
    "Pepper:other",
    "--mentioned-at",
    "2024-06-02T00:00:00.000Z",
  ]);

  expect(first.code).toBe(0);
  expect(second.code).toBe(0);
  const saved = JSON.parse(first.stdout) as { id: string; text: string; mentionedAt: string };
  const again = JSON.parse(second.stdout) as {
    id: string;
    text: string;
    mentionedAt: string;
    entities: Array<{ name: string }>;
  };
  expect(again.id).toBe(saved.id);
  expect(again.text).toBe("Maya prefers morning meetings");
  expect(again.mentionedAt).toBe(saved.mentionedAt);
  expect(again.entities.map((entity) => entity.name).sort()).toEqual(["Maya", "Pepper"]);

  const sqlite = new Database(db, { readonly: true });
  try {
    expect(sqlite.query("SELECT id FROM facts").all()).toHaveLength(1);
  } finally {
    sqlite.close();
  }
});

test("backfill against a closed port fails and leaves the stored fact", async () => {
  const db = join(tempDir(), "memory.sqlite");
  const saved = await run([
    "remember",
    "--no-embed",
    "--db",
    db,
    "--text",
    "Nia keeps a red notebook.",
    "--mentioned-at",
    "2024-08-01T00:00:00.000Z",
  ]);
  expect(saved.code).toBe(0);

  const backfill = await run([
    "backfill",
    "--db",
    db,
    "--host",
    "http://127.0.0.1:9",
    "--timeout-ms",
    "500",
  ]);
  expect(backfill.code).toBe(1);
  expect(backfill.stderr.toLowerCase()).toContain("ollama");

  const sqlite = new Database(db, { readonly: true });
  try {
    const rows = sqlite.query("SELECT text, embedding FROM facts").all() as Array<{
      text: string;
      embedding: Uint8Array | null;
    }>;
    expect(rows).toEqual([{ text: "Nia keeps a red notebook.", embedding: null }]);
  } finally {
    sqlite.close();
  }
});

test("remember stores the fact when the embed server is down", async () => {
  const db = join(tempDir(), "memory.sqlite");
  const saved = await run([
    "remember",
    "--db",
    db,
    "--text",
    "Nia keeps a red notebook.",
    "--host",
    "http://127.0.0.1:9",
    "--timeout-ms",
    "500",
    "--mentioned-at",
    "2024-08-01T00:00:00.000Z",
  ]);
  expect(saved.code).toBe(0);
  expect(JSON.parse(saved.stdout).text).toBe("Nia keeps a red notebook.");

  const sqlite = new Database(db, { readonly: true });
  try {
    const rows = sqlite.query("SELECT embedding FROM facts").all() as Array<{ embedding: Uint8Array | null }>;
    expect(rows).toEqual([{ embedding: null }]);
  } finally {
    sqlite.close();
  }

  const recalled = await run(["recall", "--db", db, "--query", "Nia notebook", "--token-budget", "40"]);
  expect(recalled.code).toBe(0);
  const body = JSON.parse(recalled.stdout) as { facts: Array<{ text: string }> };
  expect(body.facts.map((fact) => fact.text)).toEqual(["Nia keeps a red notebook."]);
});

test("hybrid recall from the CLI finds a keyword fact without an embedder", async () => {
  const db = join(tempDir(), "memory.sqlite");
  const saved = await run([
    "remember",
    "--no-embed",
    "--db",
    db,
    "--text",
    "Nia keeps a red notebook.",
    "--mentioned-at",
    "2024-08-01T00:00:00.000Z",
  ]);
  expect(saved.code).toBe(0);

  const hybrid = await run([
    "hybrid",
    "--no-embed",
    "--db",
    db,
    "--query",
    "Nia notebook",
    "--token-budget",
    "40",
  ]);
  expect(hybrid.code).toBe(0);
  const body = JSON.parse(hybrid.stdout) as { facts: Array<{ text: string; breakdown: { vector: number } }> };
  expect(body.facts.map((fact) => fact.text)).toEqual(["Nia keeps a red notebook."]);
  expect(body.facts[0]?.breakdown.vector).toBe(0);
});

test("missing command prints usage", async () => {
  const result = await run([]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("remember");
  expect(result.stderr).toContain("recall");
  expect(result.stderr).toContain("retain");
});
