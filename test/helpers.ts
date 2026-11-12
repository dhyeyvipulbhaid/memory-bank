import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export function tempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "memory-bank-"));
  return {
    path: join(dir, "bank.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function readRows<T>(path: string, sql: string, ...params: unknown[]): T[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}
