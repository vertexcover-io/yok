import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, lte, notInArray, sql } from "drizzle-orm";
import {
  type AuditMetric,
  AuditMetricSchema,
  type AuditName,
  type AuditRecord,
  type AuditReport,
  AuditReportSchema,
  type AuditResult,
  type AuditResultEvent,
  type AuditResultEventDraft,
  AuditResultEventDraftSchema,
  AuditResultEventSchema,
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

// updatedAt is kept for whoever reads yok.db by hand; no caller reads it, so it stays out of the
// returned shapes, as in storage/triggers.ts.
const toRun = ({ updatedAt: _updatedAt, ...row }: typeof tables.auditRuns.$inferSelect): AuditRun =>
  AuditRunSchema.parse(row);

const toMetric = ({
  auditRunId: _auditRunId,
  updatedAt: _updatedAt,
  ...row
}: typeof tables.auditMetrics.$inferSelect): AuditMetric => AuditMetricSchema.parse(row);

const toResult = ({
  auditRunId: _auditRunId,
  updatedAt: _updatedAt,
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

// A run starting again (a retried audit-start) gets back the audit it first opened, period and
// commits unchanged: its start step reads the clock, so a retry names a slightly later periodEnd,
// and moving the row would carry its clicked results into another period. Only a different
// project or audit name is refused, since that is a different audit.
const restartIn = (
  db: Db,
  own: typeof tables.auditRuns.$inferSelect,
  start: AuditStart,
): Result<AuditRun> => {
  if (own.project !== start.project || own.audit !== start.audit) {
    return {
      ok: false,
      error: `run ${start.runId} already holds the ${own.audit} audit of ${own.project}; it cannot also start the ${start.audit} audit of ${start.project}`,
    };
  }
  db.update(tables.auditRuns)
    .set({ status: "running" })
    .where(eq(tables.auditRuns.id, own.id))
    .run();
  return { ok: true, value: toRun({ ...own, status: "running" }) };
};

const startIn = (db: Db, start: AuditStart, at: string): Result<AuditRun> =>
  db.transaction((tx): Result<AuditRun> => {
    const owner = tx
      .select({ project: tables.runs.project })
      .from(tables.runs)
      .where(eq(tables.runs.id, start.runId))
      .get();
    if (owner !== undefined && owner.project !== start.project) {
      return {
        ok: false,
        error: `run ${start.runId} belongs to project ${owner.project}, not ${start.project}`,
      };
    }
    const own = tx
      .select()
      .from(tables.auditRuns)
      .where(eq(tables.auditRuns.runId, start.runId))
      .get();
    if (own !== undefined) return restartIn(tx, own, start);
    const holder = findHolder(tx, start);
    if (holder !== undefined) {
      return {
        ok: false,
        error: `the ${start.audit} audit of ${start.project} for ${start.periodStart} to ${start.periodEnd} is held by run ${holder.runName ?? holder.runId}`,
      };
    }
    const run = AuditRunSchema.parse({
      ...start,
      id: `a-${randomBytes(4).toString("hex")}`,
      status: "running",
      createdAt: at,
    });
    tx.insert(tables.auditRuns)
      .values({ ...run, updatedAt: at })
      .run();
    return { ok: true, value: run };
  }, IMMEDIATE);

const replaceMetrics = (db: Db, auditRunId: string, metrics: readonly AuditMetric[]): void => {
  db.delete(tables.auditMetrics).where(eq(tables.auditMetrics.auditRunId, auditRunId)).run();
  for (const metric of metrics) {
    db.insert(tables.auditMetrics)
      .values({ ...metric, auditRunId, updatedAt: now() })
      .run();
  }
};

// In place, never delete and insert: a deleted result would take its events with it.
const upsertResults = (db: Db, auditRunId: string, results: readonly AuditResult[]): void => {
  for (const result of results) {
    const row = { ...result, auditRunId, updatedAt: now() };
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

// The audit run's results that have at least one event: a retried publish never deletes them.
const findDecidedIds = (db: Db, auditRunId: string): readonly string[] =>
  db
    .selectDistinct({ id: tables.auditResultEvents.resultId })
    .from(tables.auditResultEvents)
    .innerJoin(tables.auditResults, eq(tables.auditResults.id, tables.auditResultEvents.resultId))
    .where(eq(tables.auditResults.auditRunId, auditRunId))
    .all()
    .map((row) => row.id);

const findRepeats = (keys: readonly string[]): readonly string[] => [
  ...new Set(keys.filter((key, index) => keys.indexOf(key) !== index)),
];

// Why the report cannot be stored, checked before any write so a refused report writes nothing.
const refuseReport = (auditRunId: string, report: AuditReport): string | undefined => {
  const ids = report.results.map((result) => result.id);
  const foreign = ids.filter((id) => !id.startsWith(`${auditRunId}:`));
  if (foreign.length > 0) return `result ids must start with ${auditRunId}: ${foreign.join(", ")}`;
  const repeatedIds = findRepeats(ids);
  if (repeatedIds.length > 0) return `repeated result ids: ${repeatedIds.join(", ")}`;
  // JSON, so a space inside a name never makes two different keys look alike
  const repeatedMetrics = findRepeats(
    report.metrics.map(({ repo, metric, scope }) => JSON.stringify([repo, metric, scope])),
  );
  if (repeatedMetrics.length > 0) return `repeated metrics: ${repeatedMetrics.join(", ")}`;
  return undefined;
};

const finishIn = (db: Db, auditRunId: string, report: AuditReport): Result<AuditRun> =>
  db.transaction((tx): Result<AuditRun> => {
    const run = findAuditRun(tx, auditRunId);
    if (run === undefined) return { ok: false, error: `audit run ${auditRunId} not found` };
    const refusal = refuseReport(auditRunId, report);
    if (refusal !== undefined) return { ok: false, error: refusal };
    tx.update(tables.auditRuns)
      .set({ status: report.status })
      .where(eq(tables.auditRuns.id, auditRunId))
      .run();
    replaceMetrics(tx, auditRunId, report.metrics);
    upsertResults(tx, auditRunId, report.results);
    dropUnlisted(tx, auditRunId, [
      ...report.results.map((result) => result.id),
      ...findDecidedIds(tx, auditRunId),
    ]);
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

const addEventIn = (db: Db, draft: AuditResultEventDraft, at: string): AuditResultEvent => {
  const event = AuditResultEventSchema.parse({ ...draft, id: randomUUID(), ts: at });
  db.insert(tables.auditResultEvents).values(event).run();
  return event;
};

// By rowid, not ts: two clicks in one millisecond keep the order they were stored in.
const decisionIn = (db: Db, resultId: string): AuditResultEvent | undefined => {
  const row = db
    .select()
    .from(tables.auditResultEvents)
    .where(eq(tables.auditResultEvents.resultId, resultId))
    .orderBy(desc(sql`rowid`))
    .limit(1)
    .get();
  return row === undefined ? undefined : AuditResultEventSchema.parse(row);
};

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
  addEvent: async (draft) => addEventIn(db, AuditResultEventDraftSchema.parse(draft), now()),
  decision: async (resultId) => decisionIn(db, resultId),
});
