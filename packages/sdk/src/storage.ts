import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openDatabase } from "./db.ts";
import { yokHome } from "./registry.ts";
import type { IStorage } from "./repositories.ts";
import * as tables from "./schema.ts";
import { commentRepository } from "./storage/comments.ts";
import { projectRepository } from "./storage/projects.ts";
import { runRepository } from "./storage/runs.ts";
import { triggerRepository } from "./storage/triggers.ts";
import { userRepository } from "./storage/users.ts";

const sqliteStorage = (sqlite: Database): IStorage => {
  const db = drizzle(sqlite, { schema: tables });
  return {
    users: userRepository(db),
    runs: runRepository(db),
    projects: projectRepository(db),
    comments: commentRepository(db),
    triggers: triggerRepository(db),
    close: async () => sqlite.close(),
  };
};

export const openStorage = (home: string): IStorage => {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return sqliteStorage(openDatabase(join(home, "yok.db")));
};

export const memoryStorage = (): IStorage => sqliteStorage(openDatabase(":memory:"));

// For code that holds no IStorage, such as a skill script: opens HOME/yok.db for one piece of
// work and closes it after.
export const withStorage = async <T>(
  home: string,
  use: (storage: IStorage) => Promise<T>,
): Promise<T> => {
  const storage = openStorage(home);
  try {
    return await use(storage);
  } finally {
    await storage.close();
  }
};

// The caller's storage, or, for a caller that holds none (a skill script, a subscriber module),
// the yok home's database opened for this one call.
export const useStorage = <T>(
  storage: IStorage | undefined,
  env: Readonly<Record<string, string | undefined>>,
  use: (storage: IStorage) => Promise<T>,
): Promise<T> => (storage === undefined ? withStorage(yokHome(env), use) : use(storage));
