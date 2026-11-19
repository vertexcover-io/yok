/// <reference path="./text-imports.d.ts" />
import { Database, SQLiteError } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import type { Result } from "./contracts.ts";
import m0000 from "./migrations/0000_init.sql" with { type: "text" };

export const MIN_SQLITE = "3.38.0";

// Every file drizzle-kit wrote to migrations/, in its number order; a test checks none is missing.
export const MIGRATIONS: readonly string[] = [m0000];

const MEMORY = ":memory:";
const OWNER_ONLY = 0o600;
const BREAKPOINT = "--> statement-breakpoint";
const WAL_TRIES = 50;
const WAL_RETRY_MS = 100;
// macOS ships SQLite with the system; on Linux it is the copy built into yok's bun.
const FIX: Readonly<Partial<Record<NodeJS.Platform, string>>> = { darwin: "Update macOS." };

const versionParts = (version: string): readonly number[] => version.split(".").map(Number);

const isOlder = (found: string, needed: string): boolean => {
  const [have, want] = [versionParts(found), versionParts(needed)];
  const diff = [0, 1, 2].map((at) => (have[at] ?? 0) - (want[at] ?? 0)).find((d) => d !== 0);
  return (diff ?? 0) < 0;
};

export const checkSqliteVersion = (
  found: string,
  platform: NodeJS.Platform = process.platform,
): Result<void> => {
  if (!isOlder(found, MIN_SQLITE)) return { ok: true, value: undefined };
  const fix = FIX[platform] ?? "Update yok.";
  return {
    ok: false,
    error: `SQLite ${found} is too old; yok needs ${MIN_SQLITE} or newer. ${fix}`,
  };
};

export const sqliteVersion = (): string => {
  const db = new Database(MEMORY);
  try {
    return (
      db.query<{ version: string }, []>("select sqlite_version() as version").get()?.version ?? ""
    );
  } finally {
    db.close();
  }
};

const userVersion = (db: Database): number =>
  db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;

const refuseNewer = (version: number, known: number): void => {
  if (version > known) {
    throw new Error(`yok.db was written by a newer yok (schema ${version}); update yok`);
  }
};

const applyMigration = (db: Database, migration: string): void => {
  for (const statement of migration.split(BREAKPOINT)) {
    if (statement.trim() !== "") db.run(statement);
  }
};

// Hooks open yok.db on every call, so the write lock is taken only when a migration is due, and
// the version is read again under it: another process may have migrated meanwhile.
const migrate = (db: Database, migrations: readonly string[]): void => {
  const seen = userVersion(db);
  refuseNewer(seen, migrations.length);
  if (seen === migrations.length) return;
  db.run("BEGIN IMMEDIATE");
  try {
    const current = userVersion(db);
    refuseNewer(current, migrations.length);
    for (const migration of migrations.slice(current)) applyMigration(db, migration);
    db.run(`PRAGMA user_version = ${migrations.length}`);
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
};

// yok.db holds GitHub tokens, so its three files are this user's alone. SQLite gives a -wal or
// -shm it creates later the database's own mode.
const keepOwnerOnly = (path: string): void => {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) chmodSync(file, OWNER_ONLY);
  }
};

const isBusy = (error: unknown): boolean =>
  error instanceof SQLiteError && error.code === "SQLITE_BUSY";

// Switching a new file to WAL needs it alone, and SQLite answers busy at once instead of waiting
// while another process opening the same new file holds it, so the switch is tried again.
const useWal = (db: Database, triesLeft = WAL_TRIES): void => {
  try {
    db.run("PRAGMA journal_mode = WAL");
  } catch (error) {
    if (triesLeft === 0 || !isBusy(error)) throw error;
    Bun.sleepSync(WAL_RETRY_MS);
    useWal(db, triesLeft - 1);
  }
};

export const openDatabase = (path: string): Database => {
  const checked = checkSqliteVersion(sqliteVersion());
  if (!checked.ok) throw new Error(checked.error);
  if (path !== MEMORY) closeSync(openSync(path, "a", OWNER_ONLY));
  const db = new Database(path);
  // First, so a second process waits for the one migrating.
  db.run("PRAGMA busy_timeout = 5000");
  useWal(db);
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA synchronous = NORMAL");
  if (path !== MEMORY) keepOwnerOnly(path);
  migrate(db, MIGRATIONS);
  return db;
};
