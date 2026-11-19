import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { and, asc, desc, eq, getTableColumns, inArray, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { type Comment, CommentSchema } from "./comments.ts";
import {
  type Event,
  EventSchema,
  type NodeRun,
  type Result,
  type State,
  StateSchema,
} from "./contracts.ts";
import { openDatabase } from "./db.ts";
import type { CommentDraft } from "./events.ts";
import {
  chooseProjectName,
  findProjectConflict,
  type Project,
  ProjectSchema,
  type RunDraft,
  type SessionRef,
  type WorkflowRun,
  WorkflowRunSchema,
  yokHome,
} from "./registry.ts";
import type {
  Appended,
  AppendInput,
  GitHubSignIn,
  ICommentRepository,
  IEventStore,
  ImportedRun,
  ImportedUser,
  IProjectRepository,
  IRunRepository,
  IStorage,
  ITriggerRepository,
  IUserRepository,
  UserAccount,
} from "./repositories.ts";
import * as tables from "./schema.ts";
import {
  type Fire,
  FireSchema,
  type Trigger,
  type TriggerDraft,
  TriggerSchema,
} from "./triggers.ts";
import { type Accounts, type UserEntry, UserSchema } from "./users.ts";

// The database, or a transaction on it: every helper below runs inside one or outside any.
type Db = BaseSQLiteDatabase<"sync", void, typeof tables>;
type UserRow = typeof tables.users.$inferSelect;
type AccountRow = typeof tables.userAccounts.$inferSelect;

const { users, userAccounts } = tables;
const GITHUB = "github";
const SLACK = "slack";
// Every write transaction takes the write lock at BEGIN: a deferred one fails with SQLITE_BUSY
// when it turns into a writer, instead of waiting out busy_timeout.
const IMMEDIATE = { behavior: "immediate" } as const;

const now = (): string => new Date().toISOString();
const newUserId = (): string => `u_${randomBytes(4).toString("hex")}`;

const githubAccount = (account: AccountRow | undefined): Accounts =>
  account === undefined
    ? {}
    : {
        github: {
          id: Number(account.providerId),
          login: account.username ?? "",
          ...(account.token === null ? {} : { token: account.token }),
        },
      };

const toUserEntry = (row: UserRow, accounts: readonly AccountRow[]): UserEntry => {
  const slack = accounts.find((account) => account.provider === SLACK);
  const user = UserSchema.parse({
    name: row.name,
    email: row.email,
    accounts: githubAccount(accounts.find((account) => account.provider === GITHUB)),
    ...(slack === undefined ? {} : { slack: slack.providerId }),
  });
  return [row.id, user];
};

// All users, or those with the given ids, oldest first.
const userEntries = (db: Db, ids?: readonly string[]): readonly UserEntry[] => {
  const all = db.select().from(users);
  const rows = (ids === undefined ? all : all.where(inArray(users.id, [...ids])))
    .orderBy(asc(users.createdAt), asc(users.id))
    .all();
  const owned = inArray(
    userAccounts.userId,
    rows.map((row) => row.id),
  );
  const accounts = db.select().from(userAccounts).where(owned).all();
  return rows.map((row) =>
    toUserEntry(
      row,
      accounts.filter((account) => account.userId === row.id),
    ),
  );
};

const accountOwner = (db: Db, provider: string, providerId: string): string | undefined =>
  db
    .select({ userId: userAccounts.userId })
    .from(userAccounts)
    .where(and(eq(userAccounts.provider, provider), eq(userAccounts.providerId, providerId)))
    .get()?.userId;

// One account belongs to one yok user: saving it for userId moves it off anyone who had it. The
// row is replaced whole, so a token left out is dropped.
const putAccount = (tx: Db, userId: string, account: UserAccount, at: string): void => {
  const { provider, providerId } = account;
  tx.delete(userAccounts)
    .where(
      and(
        eq(userAccounts.provider, provider),
        eq(userAccounts.providerId, providerId),
        ne(userAccounts.userId, userId),
      ),
    )
    .run();
  const fields = {
    providerId,
    username: account.username ?? null,
    token: account.token ?? null,
    updatedAt: at,
  };
  tx.insert(userAccounts)
    .values({ userId, provider, ...fields, createdAt: at })
    .onConflictDoUpdate({ target: [userAccounts.userId, userAccounts.provider], set: fields })
    .run();
};

// The same GitHub account always maps to the same yok user; its name, email and login follow
// GitHub's on every sign-in, and the sign-in's token becomes its GitHub connector. The account is
// looked up under the write lock, so two first sign-ins of one account make one user.
const saveGitHubRows = (db: Db, input: GitHubSignIn): string =>
  db.transaction((tx) => {
    const at = now();
    const providerId = String(input.id);
    const id = accountOwner(tx, GITHUB, providerId) ?? newUserId();
    const person = { name: input.name, email: input.email, updatedAt: at };
    tx.insert(users)
      .values({ id, ...person, createdAt: at })
      .onConflictDoUpdate({ target: users.id, set: person })
      .run();
    const account = { provider: GITHUB, providerId, username: input.login, token: input.token };
    putAccount(tx, id, account, at);
    return id;
  }, IMMEDIATE);

// The rows saveGitHubUser and a Slack link would have written, for a user users.json held.
const importedAccountRows = (
  userId: string,
  { github, slack }: ImportedUser,
  at: string,
): (typeof userAccounts.$inferInsert)[] => {
  const stamps = { userId, createdAt: at, updatedAt: at };
  return [
    ...(github === undefined
      ? []
      : [
          {
            ...stamps,
            provider: GITHUB,
            providerId: String(github.id),
            username: github.login,
            token: github.token ?? null,
          },
        ]),
    ...(slack === undefined ? [] : [{ ...stamps, provider: SLACK, providerId: slack }]),
  ];
};

const importUserIn = (db: Db, id: string, user: ImportedUser, at: string): void =>
  db.transaction((tx) => {
    tx.insert(users)
      .values({ id, name: user.name, email: user.email, createdAt: at, updatedAt: at })
      .onConflictDoNothing()
      .run();
    const accounts = importedAccountRows(id, user, at);
    if (accounts.length > 0) tx.insert(userAccounts).values(accounts).onConflictDoNothing().run();
  }, IMMEDIATE);

const userRepository = (db: Db): IUserRepository => ({
  list: async () => userEntries(db),
  find: async (id) => userEntries(db, [id])[0]?.[1],
  findByAccount: async (provider, providerId) => {
    const id = accountOwner(db, provider, providerId);
    return id === undefined ? undefined : userEntries(db, [id])[0];
  },
  saveGitHubUser: async (input) => {
    const id = saveGitHubRows(db, input);
    const [entry] = userEntries(db, [id]);
    if (entry === undefined) throw new Error(`user ${id} was not saved`);
    return entry;
  },
  addUserAccount: async (userId, account) => {
    db.transaction((tx) => putAccount(tx, userId, account, now()), IMMEDIATE);
  },
  removeUserAccount: async (userId, provider) => {
    db.delete(userAccounts)
      .where(and(eq(userAccounts.userId, userId), eq(userAccounts.provider, provider)))
      .run();
  },
  importUser: async (id, user) => importUserIn(db, id, user, now()),
});

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

const runRepository = (db: Db): IRunRepository => ({
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
  importRun: async (input) => importRunIn(db, input, now()),
});

type ProjectRow = typeof tables.projects.$inferSelect;

const toProject = (row: ProjectRow): Project =>
  ProjectSchema.parse({
    path: row.path,
    ...(row.git === null ? {} : { git: row.git }),
    addedBy: { channel: row.channel },
    addedAt: row.createdAt,
  });

const toProjectRow = (name: string, project: Project) => ({
  name,
  path: project.path,
  git: project.git ?? null,
  channel: project.addedBy.channel,
  createdAt: project.addedAt,
  updatedAt: now(),
});

const listProjectsIn = (db: Db): Readonly<Record<string, Project>> =>
  Object.fromEntries(
    db
      .select()
      .from(tables.projects)
      .orderBy(asc(tables.projects.createdAt))
      .all()
      .map((row) => [row.name, toProject(row)]),
  );

// Never refuses: a trigger saved on main for this folder must keep a project to fire in.
const findOrAddFolderIn = (db: Db, folder: string): string =>
  db.transaction((tx) => {
    const projects = listProjectsIn(tx);
    const known = Object.entries(projects).find(([, project]) => project.path === folder);
    if (known !== undefined) return known[0];
    const name = chooseProjectName(projects, folder);
    const project = { path: folder, addedBy: { channel: "server" }, addedAt: now() };
    tx.insert(tables.projects).values(toProjectRow(name, project)).run();
    return name;
  }, IMMEDIATE);

const addProjectIn = (db: Db, name: string, project: Project): Result<void> =>
  db.transaction((tx): Result<void> => {
    const claim = { name, git: project.git, root: project.path };
    const conflict = findProjectConflict(listProjectsIn(tx), claim);
    if (conflict !== null) return { ok: false, error: conflict };
    tx.insert(tables.projects).values(toProjectRow(name, project)).run();
    return { ok: true, value: undefined };
  }, IMMEDIATE);

const projectRepository = (db: Db): IProjectRepository => ({
  list: async () => listProjectsIn(db),
  find: async (name) => {
    const row = db.select().from(tables.projects).where(eq(tables.projects.name, name)).get();
    return row === undefined ? undefined : toProject(row);
  },
  findOrAddFolder: async (folder) => findOrAddFolderIn(db, folder),
  add: async (name, project) => addProjectIn(db, name, project),
  remove: async (name) =>
    db
      .delete(tables.projects)
      .where(eq(tables.projects.name, name))
      .returning({ name: tables.projects.name })
      .all().length > 0,
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

const eventStore = (db: Db, runId: string): IEventStore => ({
  read: async () =>
    db
      .select()
      .from(tables.events)
      .where(eq(tables.events.runId, runId))
      .orderBy(asc(tables.events.seq))
      .all()
      .map(toEvent),
  readState: async () => {
    const row = db
      .select({ state: tables.runs.state })
      .from(tables.runs)
      .where(eq(tables.runs.id, runId))
      .get();
    const state = row?.state ?? null;
    return state === null ? null : StateSchema.parse(state);
  },
  append: async (input) => appendIn(db, runId, input),
});

type CommentRow = typeof tables.comments.$inferSelect;

const toComment = (row: CommentRow): Comment =>
  CommentSchema.parse({
    id: row.id,
    file: row.file,
    kind: row.kind,
    text: row.text,
    status: row.status,
    createdAt: row.createdAt,
    ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt }),
    ...(row.anchor === null ? {} : { anchor: row.anchor }),
    thread: row.thread,
  });

const commentNumber = (id: string): number => Number.parseInt(id.slice(1), 10) || 0;

const selectComments = (db: Db, runId: string): readonly Comment[] =>
  db
    .select()
    .from(tables.comments)
    .where(eq(tables.comments.runId, runId))
    .all()
    .map(toComment)
    .toSorted((a, b) => commentNumber(a.id) - commentNumber(b.id));

const userWords = (draft: CommentDraft): string => {
  if (draft.kind === "delete")
    return `Delete this.${draft.text.trim() === "" ? "" : ` ${draft.text}`}`;
  if (draft.kind === "replace") return `Replace with “${draft.text}”`;
  return draft.text;
};

// Numbered from the highest cN, not the row count, so ids match the ones comments.json held.
const insertComments = (
  db: Db,
  runId: string,
  drafts: readonly CommentDraft[],
  at: string,
): readonly Comment[] =>
  db.transaction((tx) => {
    const first = Math.max(0, ...selectComments(tx, runId).map((c) => commentNumber(c.id))) + 1;
    const added = drafts.map(
      (draft, i): Comment => ({
        ...draft,
        id: `c${first + i}`,
        status: "sent",
        createdAt: at,
        thread: [{ by: "user", text: userWords(draft), at }],
      }),
    );
    tx.insert(tables.comments)
      .values(added.map((comment) => ({ ...comment, runId, updatedAt: at })))
      .run();
    return added;
  }, IMMEDIATE);

const updateComment = (
  db: Db,
  runId: string,
  id: string,
  change: (comment: Comment) => Comment,
): Result<Comment> =>
  db.transaction((tx): Result<Comment> => {
    const where = and(eq(tables.comments.runId, runId), eq(tables.comments.id, id));
    const row = tx.select().from(tables.comments).where(where).get();
    if (row === undefined) return { ok: false, error: `no comment ${id}` };
    const updated = change(toComment(row));
    tx.update(tables.comments)
      .set({ status: updated.status, thread: updated.thread })
      .where(where)
      .run();
    return { ok: true, value: updated };
  }, IMMEDIATE);

// `typed` is the comments as they were when typed into the session. One that gained a thread
// entry since (a user reply posted mid-delivery) stays sent, so its new words go out next time.
const markCommentsDelivered = (
  db: Db,
  runId: string,
  typed: readonly Comment[],
  at: string,
): readonly Comment[] =>
  db.transaction((tx) => {
    const marked = selectComments(tx, runId)
      .filter(
        (comment) =>
          comment.status === "sent" &&
          typed.some((t) => t.id === comment.id && t.thread.length === comment.thread.length),
      )
      .map((comment): Comment => ({ ...comment, status: "delivered", deliveredAt: at }));
    if (marked.length === 0) return marked;
    const ids = marked.map((comment) => comment.id);
    tx.update(tables.comments)
      .set({ status: "delivered", deliveredAt: at })
      .where(and(eq(tables.comments.runId, runId), inArray(tables.comments.id, ids)))
      .run();
    return marked;
  }, IMMEDIATE);

// The time is read before each transaction: its callback is synchronous and must await nothing.
const commentRepository = (db: Db): ICommentRepository => ({
  list: async (runId) => selectComments(db, runId),
  add: async (runId, drafts) =>
    drafts.length === 0 ? [] : insertComments(db, runId, drafts, now()),
  addUserReply: async (runId, id, text) => {
    const at = now();
    return updateComment(db, runId, id, (comment) => ({
      ...comment,
      status: "sent",
      thread: [...comment.thread, { by: "user", text, at }],
    }));
  },
  reply: async (runId, id, reply) => {
    if (reply.text.trim() === "") return { ok: false, error: "the reply has no text" };
    const at = now();
    return updateComment(db, runId, id, (comment) => ({
      ...comment,
      status: reply.status,
      thread: [...comment.thread, { by: "agent", text: reply.text, at }],
    }));
  },
  markDelivered: async (runId, typed) => markCommentsDelivered(db, runId, typed, now()),
  importComments: async (runId, imported) => {
    const at = now();
    db.transaction((tx) => {
      for (const comment of imported) {
        tx.insert(tables.comments)
          .values({ ...comment, runId, updatedAt: at })
          .onConflictDoNothing()
          .run();
      }
    }, IMMEDIATE);
  },
});

const toTrigger = ({
  updatedAt: _updatedAt,
  ...row
}: typeof tables.triggers.$inferSelect): Trigger => TriggerSchema.parse(row);

const toFire = ({
  reason,
  runId,
  runName,
  ...fire
}: typeof tables.triggerFires.$inferSelect): Fire =>
  FireSchema.parse({
    ...fire,
    ...(reason === null ? {} : { reason }),
    ...(runId === null ? {} : { runId }),
    ...(runName === null ? {} : { runName }),
  });

// In one project, a name belongs to one workflow and a workflow to one name.
const isClash = (stored: Trigger, draft: TriggerDraft): boolean =>
  (stored.name === draft.name) !== (stored.workflow === draft.workflow);

const saveTriggerIn = (db: Db, draft: TriggerDraft, at: string): Result<Trigger, Trigger> =>
  db.transaction((tx): Result<Trigger, Trigger> => {
    const inProject = tx
      .select()
      .from(tables.triggers)
      .where(eq(tables.triggers.project, draft.project))
      .all()
      .map(toTrigger);
    const clash = inProject.find((stored) => isClash(stored, draft));
    if (clash !== undefined) return { ok: false, error: clash };
    const existing = inProject.find((stored) => stored.name === draft.name);
    const trigger = TriggerSchema.parse({
      ...draft,
      id: existing?.id ?? `t-${randomBytes(4).toString("hex")}`,
      createdAt: existing?.createdAt ?? at,
    });
    if (existing === undefined) {
      tx.insert(tables.triggers)
        .values({ ...trigger, updatedAt: at })
        .run();
    } else {
      tx.update(tables.triggers).set(trigger).where(eq(tables.triggers.id, trigger.id)).run();
    }
    return { ok: true, value: trigger };
  }, IMMEDIATE);

// A removed trigger's fire log went with it, so its late fire is dropped, not refused: a
// foreign-key error would abort the rest of the tick.
const appendFireIn = (db: Db, fire: Fire): void =>
  db.transaction((tx) => {
    const held = tx
      .select({ id: tables.triggers.id })
      .from(tables.triggers)
      .where(eq(tables.triggers.id, fire.triggerId))
      .get();
    if (held !== undefined) tx.insert(tables.triggerFires).values(fire).run();
  }, IMMEDIATE);

const triggerRepository = (db: Db): ITriggerRepository => ({
  list: async () => db.select().from(tables.triggers).all().map(toTrigger),
  find: async (project, name) => {
    const row = db
      .select()
      .from(tables.triggers)
      .where(and(eq(tables.triggers.project, project), eq(tables.triggers.name, name)))
      .get();
    return row === undefined ? undefined : toTrigger(row);
  },
  save: async (draft) => saveTriggerIn(db, draft, now()),
  remove: async (id) =>
    db
      .delete(tables.triggers)
      .where(eq(tables.triggers.id, id))
      .returning({ id: tables.triggers.id })
      .all().length > 0,
  // Matching the cron and timezone read leaves alone a trigger re-saved since (ADR 0023).
  setNextFireAt: async (trigger, nextFireAt) =>
    db
      .update(tables.triggers)
      .set({ nextFireAt })
      .where(
        and(
          eq(tables.triggers.id, trigger.id),
          eq(tables.triggers.cron, trigger.cron),
          eq(tables.triggers.timezone, trigger.timezone),
        ),
      )
      .returning({ id: tables.triggers.id })
      .all().length > 0,
  appendFire: async (fire) => appendFireIn(db, FireSchema.parse(fire)),
  // By rowid, not at: the tick writes a missed-slots fire and its firing with one at.
  readFires: async (triggerId, limit) =>
    db
      .select()
      .from(tables.triggerFires)
      .where(eq(tables.triggerFires.triggerId, triggerId))
      .orderBy(desc(sql`rowid`))
      .limit(limit)
      .all()
      .map(toFire)
      .toReversed(),
  importTrigger: async (trigger) =>
    db
      .insert(tables.triggers)
      .values({ ...trigger, updatedAt: now() })
      .onConflictDoNothing()
      .returning({ id: tables.triggers.id })
      .all().length > 0
      ? { ok: true, value: undefined }
      : { ok: false, error: `trigger ${trigger.id} is already stored` },
});

const sqliteStorage = (sqlite: Database): IStorage => {
  const db = drizzle(sqlite, { schema: tables });
  return {
    users: userRepository(db),
    runs: runRepository(db),
    projects: projectRepository(db),
    comments: commentRepository(db),
    triggers: triggerRepository(db),
    events: (runId) => eventStore(db, runId),
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
