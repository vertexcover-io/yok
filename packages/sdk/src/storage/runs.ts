import { and, asc, desc, eq, getTableColumns, sql } from "drizzle-orm";
import {
  type Event,
  EventSchema,
  type NodeRun,
  type Result,
  type State,
  StateSchema,
} from "../contracts.ts";
import {
  type RunDraft,
  type SessionRef,
  type WorkflowRun,
  WorkflowRunSchema,
} from "../registry.ts";
import type { Appended, AppendInput, ImportedRun, IRunRepository } from "../repositories.ts";
import * as tables from "../schema.ts";
import { type Db, IMMEDIATE, now } from "./common.ts";

const runColumns = { ...getTableColumns(tables.runs), cwd: tables.projects.path };

const selectRuns = (db: Db) =>
  db
    .select(runColumns)
    .from(tables.runs)
    .innerJoin(tables.projects, eq(tables.runs.project, tables.projects.name));

type RunRow = ReturnType<ReturnType<typeof selectRuns>["all"]>[number];

const toRun = (row: RunRow): WorkflowRun =>
  WorkflowRunSchema.parse({
    id: row.id,
    project: row.project,
    workflow: row.workflow,
    workflowPath: row.workflowPath,
    inputs: row.inputs,
    cwd: row.cwd,
    sessions: row.sessions,
    name: row.name,
    terminal: row.terminal,
    config: row.config,
    tiers: row.tiers,
    ...(row.policies === null ? {} : { policies: row.policies }),
    ...(row.permissionMode === null ? {} : { permissionMode: row.permissionMode }),
    ...(row.source === null ? {} : { source: row.source }),
    ...(row.userId === null ? {} : { user: row.userId }),
    createdAt: row.createdAt,
  });

const toRunRow = (run: RunDraft) => ({
  id: run.id,
  project: run.project,
  name: run.name,
  workflow: run.workflow,
  workflowPath: run.workflowPath,
  config: run.config,
  terminal: run.terminal,
  permissionMode: run.permissionMode ?? null,
  source: run.source ?? null,
  userId: run.user ?? null,
  inputs: run.inputs,
  sessions: run.sessions,
  tiers: run.tiers,
  policies: run.policies ?? null,
  createdAt: run.createdAt,
  updatedAt: now(),
});

// The unique (project, name) key would refuse a clash too; reading first names the project.
const nameTakenError = (db: Db, project: string, name: string): string | undefined =>
  db
    .select({ id: tables.runs.id })
    .from(tables.runs)
    .where(and(eq(tables.runs.project, project), eq(tables.runs.name, name)))
    .get() === undefined
    ? undefined
    : `run name ${name} is taken in project ${project}`;

const initRunIn = (db: Db, runId: string, name: string, state: State): Result<void> =>
  db.transaction((tx): Result<void> => {
    const run = tx
      .select({ project: tables.runs.project })
      .from(tables.runs)
      .where(eq(tables.runs.id, runId))
      .get();
    if (run === undefined) return { ok: false, error: `run ${runId} not found` };
    const taken = nameTakenError(tx, run.project, name);
    if (taken !== undefined) return { ok: false, error: taken };
    tx.update(tables.runs)
      .set({ name, state, lastEventSeq: state.lastEventSeq })
      .where(eq(tables.runs.id, runId))
      .run();
    return { ok: true, value: undefined };
  }, IMMEDIATE);

const releaseRunIn = (db: Db, runId: string): void =>
  db.transaction((tx) => {
    tx.delete(tables.events).where(eq(tables.events.runId, runId)).run();
    tx.delete(tables.artifacts).where(eq(tables.artifacts.runId, runId)).run();
    tx.update(tables.runs)
      .set({ name: null, state: null, lastEventSeq: 0 })
      .where(eq(tables.runs.id, runId))
      .run();
  }, IMMEDIATE);

const linkSessionIn = (db: Db, runId: string, session: SessionRef): void =>
  db.transaction((tx) => {
    const run = tx
      .select({ sessions: tables.runs.sessions })
      .from(tables.runs)
      .where(eq(tables.runs.id, runId))
      .get();
    if (run === undefined) return;
    const sessions = WorkflowRunSchema.shape.sessions.parse(run.sessions);
    const linked = sessions.some(
      (existing) => existing.agent === session.agent && existing.sessionId === session.sessionId,
    );
    if (linked) return;
    tx.update(tables.runs)
      .set({ sessions: [...sessions, session] })
      .where(eq(tables.runs.id, runId))
      .run();
  }, IMMEDIATE);

// The run as an older yok left it: name, state and events land together, numbered as they were.
// One insert per event: a run's few thousand events in one statement would pass SQLite's limit
// on bound values.
const importRunIn = (db: Db, { run, state, events }: ImportedRun, at: string): Result<void> =>
  db.transaction((tx): Result<void> => {
    const stored = tx
      .select({ id: tables.runs.id })
      .from(tables.runs)
      .where(eq(tables.runs.id, run.id))
      .get();
    if (stored !== undefined) return { ok: false, error: `run ${run.id} is already stored` };
    const taken = run.name === null ? undefined : nameTakenError(tx, run.project, run.name);
    if (taken !== undefined) return { ok: false, error: taken };
    tx.insert(tables.runs)
      .values({ ...toRunRow(run), state, lastEventSeq: events.length })
      .run();
    for (const event of events) tx.insert(tables.events).values(toEventRow(event)).run();
    const artifacts = toArtifactRows(run.id, state, at);
    if (artifacts.length > 0) {
      tx.insert(tables.artifacts).values(artifacts).onConflictDoNothing().run();
    }
    return { ok: true, value: undefined };
  }, IMMEDIATE);

export const runRepository = (db: Db): IRunRepository => ({
  findRun: async (runId) => {
    const row = selectRuns(db).where(eq(tables.runs.id, runId)).get();
    return row === undefined ? undefined : toRun(row);
  },
  findRunsByName: async (name) =>
    selectRuns(db)
      .where(eq(tables.runs.name, name))
      .orderBy(desc(tables.runs.createdAt))
      .all()
      .map(toRun),
  listRuns: async () => selectRuns(db).orderBy(asc(tables.runs.createdAt)).all().map(toRun),
  addRun: async (run) => {
    db.insert(tables.runs).values(toRunRow(run)).run();
  },
  removeRun: async (runId) => {
    db.delete(tables.runs).where(eq(tables.runs.id, runId)).run();
  },
  initRun: async (runId, name, state) => initRunIn(db, runId, name, state),
  releaseRun: async (runId) => releaseRunIn(db, runId),
  setTerminal: async (runId, terminal) => {
    db.update(tables.runs).set({ terminal }).where(eq(tables.runs.id, runId)).run();
  },
  linkSession: async (runId, session) => linkSessionIn(db, runId, session),
  readEvents: async (runId) => toEvents(db, runId),
  readEvent: async (runId, eventId) => toEvents(db, runId, eventId)[0],
  readState: async (runId) => readStateIn(db, runId),
  appendEvent: async (runId, input) => appendIn(db, runId, input),
  importRun: async (input) => importRunIn(db, input, now()),
});

type EventRow = typeof tables.events.$inferSelect;

const toEvent = (row: EventRow): Event =>
  EventSchema.parse({
    schemaVersion: row.schemaVersion,
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    type: row.type,
    source: row.source,
    runId: row.runId,
    ...(row.nodeId === null ? {} : { nodeId: row.nodeId }),
    ...(row.nodeRunId === null ? {} : { nodeRunId: row.nodeRunId }),
    ...(row.stage === null ? {} : { stage: row.stage }),
    payload: row.payload,
  });

const toEventRow = (event: Event) => ({
  runId: event.runId,
  seq: event.seq,
  id: event.id,
  ts: event.ts,
  type: event.type,
  source: event.source,
  nodeId: event.nodeId ?? null,
  nodeRunId: event.nodeRunId ?? null,
  stage: event.stage ?? null,
  schemaVersion: event.schemaVersion,
  // Drizzle writes a JS null as SQL NULL, which the NOT NULL payload column refuses.
  payload: event.payload === null ? sql`'null'` : event.payload,
});

const collectNodeRuns = (runs: Readonly<Record<string, NodeRun>>): readonly NodeRun[] =>
  Object.values(runs).flatMap((run) => [run, ...collectNodeRuns(run.nodes ?? {})]);

// One row per artifact a node run lists in the state, nested node runs too.
const toArtifactRows = (runId: string, state: State | null, createdAt: string) =>
  collectNodeRuns(state?.nodeRuns ?? {}).flatMap((nodeRun) =>
    nodeRun.artifacts.map((artifact) => ({
      runId,
      nodeRunId: nodeRun.nodeRunId,
      type: artifact.type,
      name: artifact.name,
      path: "path" in artifact ? artifact.path : null,
      url: "url" in artifact ? artifact.url : null,
      createdAt,
    })),
  );

// The event lands only while the run's last stored seq is the one the caller folded from, so two
// writers never store the same seq, and no state misses an event stored before it.
const appendIn = (db: Db, runId: string, { event, state, expectedSeq }: AppendInput): Appended =>
  db.transaction((tx): Appended => {
    const stored = tx
      .select()
      .from(tables.events)
      .where(and(eq(tables.events.runId, runId), eq(tables.events.id, event.id)))
      .get();
    if (stored !== undefined) return { kind: "exists", event: toEvent(stored) };
    const run = tx
      .select({ lastEventSeq: tables.runs.lastEventSeq })
      .from(tables.runs)
      .where(eq(tables.runs.id, runId))
      .get();
    if (run === undefined) throw new Error(`run ${runId} not found`);
    if (run.lastEventSeq !== expectedSeq) return { kind: "conflict" };
    tx.insert(tables.events).values(toEventRow(event)).run();
    tx.update(tables.runs)
      .set(state === null ? { lastEventSeq: event.seq } : { lastEventSeq: event.seq, state })
      .where(eq(tables.runs.id, runId))
      .run();
    const artifacts = toArtifactRows(runId, state, event.ts);
    if (artifacts.length > 0) {
      tx.insert(tables.artifacts).values(artifacts).onConflictDoNothing().run();
    }
    return { kind: "stored", event };
  }, IMMEDIATE);

const toEvents = (db: Db, runId: string, eventId?: string): readonly Event[] =>
  db
    .select()
    .from(tables.events)
    .where(
      eventId === undefined
        ? eq(tables.events.runId, runId)
        : and(eq(tables.events.runId, runId), eq(tables.events.id, eventId)),
    )
    .orderBy(asc(tables.events.seq))
    .all()
    .map(toEvent);

const readStateIn = (db: Db, runId: string): State | null => {
  const row = db
    .select({ state: tables.runs.state })
    .from(tables.runs)
    .where(eq(tables.runs.id, runId))
    .get();
  const state = row?.state ?? null;
  return state === null ? null : StateSchema.parse(state);
};
