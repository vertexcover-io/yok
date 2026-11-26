import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, lte, notInArray } from "drizzle-orm";
import {
  type AuditMetric,
  AuditMetricSchema,
  type AuditName,
  type AuditRecord,
  type AuditReport,
  AuditReportSchema,
  type AuditResult,
  AuditResultSchema,
  type AuditRun,
  type AuditRunFilter,
  AuditRunSchema,
  type AuditStart,
  AuditStartSchema,
} from "../audits.ts";
import type { Result } from "../contracts.ts";
import type { IAuditRepository } from "../repositories.ts";
import * as tables from "../schema.ts";
import { type Db, IMMEDIATE, now } from "./common.ts";

// One spelling per instant: "…00Z" and "…00.000Z" are one period and sort as one.
const instant = (iso: string): string => new Date(iso).toISOString();

const toRun = (row: typeof tables.auditRuns.$inferSelect): AuditRun => AuditRunSchema.parse(row);

const toMetric = ({
  auditRunId: _auditRunId,
  ...row
}: typeof tables.auditMetrics.$inferSelect): AuditMetric => AuditMetricSchema.parse(row);

const toResult = ({
  auditRunId: _auditRunId,
  ...row
}: typeof tables.auditResults.$inferSelect): AuditResult => AuditResultSchema.parse(row);

const findAuditRun = (db: Db, id: string): AuditRun | undefined => {
  const row = db.select().from(tables.auditRuns).where(eq(tables.auditRuns.id, id)).get();
  return row === undefined ? undefined : toRun(row);
};

const findHolder = (db: Db, start: AuditStart) =>
  db
    .select({ runId: tables.auditRuns.runId, runName: tables.runs.name })
    .from(tables.auditRuns)
    .innerJoin(tables.runs, eq(tables.runs.id, tables.auditRuns.runId))
    .where(
      and(
        eq(tables.auditRuns.project, start.project),
        eq(tables.auditRuns.audit, start.audit),
        eq(tables.auditRuns.periodStart, start.periodStart),
        eq(tables.auditRuns.periodEnd, start.periodEnd),
      ),
    )
    .get();

const startIn = (db: Db, start: AuditStart, at: string): Result<AuditRun> =>
  db.transaction((tx): Result<AuditRun> => {
    const holder = findHolder(tx, start);
    if (holder !== undefined && holder.runId !== start.runId) {
      return {
        ok: false,
        error: `the ${start.audit} audit of ${start.project} for ${start.periodStart} to ${start.periodEnd} is held by run ${holder.runName ?? holder.runId}`,
      };
    }
    const own = tx
      .select()
      .from(tables.auditRuns)
      .where(eq(tables.auditRuns.runId, start.runId))
      .get();
    const run = AuditRunSchema.parse({
      ...start,
      id: own?.id ?? `a-${randomBytes(4).toString("hex")}`,
      status: "running",
      createdAt: own?.createdAt ?? at,
    });
    if (own === undefined) {
      tx.insert(tables.auditRuns).values(run).run();
    } else {
      tx.update(tables.auditRuns).set(run).where(eq(tables.auditRuns.id, run.id)).run();
    }
    return { ok: true, value: run };
  }, IMMEDIATE);

const replaceMetrics = (db: Db, auditRunId: string, metrics: readonly AuditMetric[]): void => {
  db.delete(tables.auditMetrics).where(eq(tables.auditMetrics.auditRunId, auditRunId)).run();
  for (const metric of metrics) {
    db.insert(tables.auditMetrics)
      .values({ ...metric, auditRunId })
      .run();
  }
};

// In place, never delete and insert: a deleted result would take its events with it.
const upsertResults = (db: Db, auditRunId: string, results: readonly AuditResult[]): void => {
  for (const result of results) {
    const row = { ...result, auditRunId };
    db.insert(tables.auditResults)
      .values(row)
      .onConflictDoUpdate({ target: tables.auditResults.id, set: row })
      .run();
  }
};

const dropUnlisted = (db: Db, auditRunId: string, keep: readonly string[]): void => {
  db.delete(tables.auditResults)
    .where(
      and(
        eq(tables.auditResults.auditRunId, auditRunId),
        notInArray(tables.auditResults.id, [...keep]),
      ),
    )
    .run();
};

const finishIn = (db: Db, auditRunId: string, report: AuditReport): Result<AuditRun> =>
  db.transaction((tx): Result<AuditRun> => {
    const run = findAuditRun(tx, auditRunId);
    if (run === undefined) return { ok: false, error: `audit run ${auditRunId} not found` };
    const foreign = report.results
      .map((result) => result.id)
      .filter((id) => !id.startsWith(`${auditRunId}:`));
    if (foreign.length > 0) {
      return {
        ok: false,
        error: `result ids must start with ${auditRunId}: ${foreign.join(", ")}`,
      };
    }
    tx.update(tables.auditRuns)
      .set({ status: report.status })
      .where(eq(tables.auditRuns.id, auditRunId))
      .run();
    replaceMetrics(tx, auditRunId, report.metrics);
    upsertResults(tx, auditRunId, report.results);
    dropUnlisted(
      tx,
      auditRunId,
      report.results.map((result) => result.id),
    );
    return { ok: true, value: { ...run, status: report.status } };
  }, IMMEDIATE);

const listIn = (
  db: Db,
  project: string,
  audit: AuditName,
  filter: AuditRunFilter,
): readonly AuditRun[] =>
  db
    .select()
    .from(tables.auditRuns)
    .where(
      and(
        eq(tables.auditRuns.project, project),
        eq(tables.auditRuns.audit, audit),
        filter.from === undefined
          ? undefined
          : gte(tables.auditRuns.periodStart, instant(filter.from)),
        filter.to === undefined ? undefined : lte(tables.auditRuns.periodEnd, instant(filter.to)),
      ),
    )
    .orderBy(desc(tables.auditRuns.periodEnd), desc(tables.auditRuns.periodStart))
    // -1 is SQLite's "no limit"
    .limit(filter.limit ?? -1)
    .all()
    .map(toRun);

// One read transaction, so a publish landing meanwhile is seen whole or not at all.
const readIn = (db: Db, auditRunId: string): AuditRecord | undefined =>
  db.transaction((tx) => {
    const run = findAuditRun(tx, auditRunId);
    if (run === undefined) return undefined;
    const metrics = tx
      .select()
      .from(tables.auditMetrics)
      .where(eq(tables.auditMetrics.auditRunId, auditRunId))
      .orderBy(
        asc(tables.auditMetrics.repo),
        asc(tables.auditMetrics.metric),
        asc(tables.auditMetrics.scope),
      )
      .all()
      .map(toMetric);
    const results = tx
      .select()
      .from(tables.auditResults)
      .where(eq(tables.auditResults.auditRunId, auditRunId))
      .orderBy(asc(tables.auditResults.id))
      .all()
      .map(toResult);
    return { run, metrics, results };
  });

// Normalized before the holder lookup, so two spellings of one period find the same row.
const parseStart = (start: AuditStart): AuditStart => {
  const parsed = AuditStartSchema.parse(start);
  return {
    ...parsed,
    periodStart: instant(parsed.periodStart),
    periodEnd: instant(parsed.periodEnd),
  };
};

export const auditRepository = (db: Db): IAuditRepository => ({
  start: async (start) => startIn(db, parseStart(start), now()),
  finish: async (auditRunId, report) => finishIn(db, auditRunId, AuditReportSchema.parse(report)),
  list: async (project, audit, filter = {}) => listIn(db, project, audit, filter),
  read: async (auditRunId) => readIn(db, auditRunId),
});
