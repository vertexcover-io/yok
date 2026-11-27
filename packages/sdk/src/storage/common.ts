import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as tables from "../schema.ts";

// The database, or a transaction on it: every helper below runs inside one or outside any.
export type Db = BaseSQLiteDatabase<"sync", void, typeof tables>;

// Every write transaction takes the write lock at BEGIN: a deferred one fails with SQLITE_BUSY
// when it turns into a writer, instead of waiting out busy_timeout.
export const IMMEDIATE = { behavior: "immediate" } as const;

export const now = (): string => new Date().toISOString();
