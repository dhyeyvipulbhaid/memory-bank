import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.ts";

export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    const directory = dirname(path);
    if (directory && directory !== ".") mkdirSync(directory, { recursive: true });
  }
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA_SQL);
  return db;
}
