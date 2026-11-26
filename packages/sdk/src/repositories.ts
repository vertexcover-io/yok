import type * as z from "zod";
import type {
  AuditName,
  AuditRecord,
  AuditReport,
  AuditRun,
  AuditRunFilter,
  AuditStart,
} from "./audits.ts";
import type { AgentReply, Comment } from "./comments.ts";
import type { Event, EventSchema, Result, State } from "./contracts.ts";
import type { CommentDraft } from "./events.ts";
import type { Project, RunDraft, SessionRef, WorkflowRun } from "./registry.ts";
import type { Fire, Trigger, TriggerDraft } from "./triggers.ts";
import type { User, UserEntry } from "./users.ts";

// What a GitHub sign-in learns of the person, and the token it was granted.
export type GitHubSignIn = Readonly<{
  id: number;
  login: string;
  name: string;
  email: string;
  token: string;
}>;

// A person's account at another service: github, slack, and later others. providerId is the
// service's permanent id for the person; a token is kept only for a service yok acts through.
export type UserAccount = Readonly<{
  provider: string;
  providerId: string;
  username?: string;
  token?: string;
}>;

export interface IUserRepository {
  list(): Promise<readonly UserEntry[]>;
  find(id: string): Promise<User | undefined>;
  findByAccount(provider: string, providerId: string): Promise<UserEntry | undefined>;
  saveGitHubUser(input: GitHubSignIn): Promise<UserEntry>;
  addUserAccount(userId: string, account: UserAccount): Promise<void>;
  removeUserAccount(userId: string, provider: string): Promise<void>;
  // Only for `yok import-files`: stores the user under its old id. Deleted with that command.
  importUser(id: string, user: ImportedUser): Promise<void>;
}

// A user as users.json held it, for `yok import-files`.
export type ImportedUser = Readonly<{
  name: string;
  email: string;
  github?: Readonly<{ id: number; login: string; token?: string | undefined }> | undefined;
  slack?: string | undefined;
}>;

export interface IRunRepository {
  findRun(runId: string): Promise<WorkflowRun | undefined>;
  // every project's runs with that name, newest first
  findRunsByName(name: string): Promise<readonly WorkflowRun[]>;
  listRuns(): Promise<readonly WorkflowRun[]>;
  // rejects when run.project has no row: a project removed meanwhile keeps no new run
  addRun(run: RunDraft): Promise<void>;
  // its events and artifact rows go with it
  removeRun(runId: string): Promise<void>;
  initRun(runId: string, name: string, state: State): Promise<Result<void>>;
  // undoes initRun: the name, state and events go, so init can run again
  releaseRun(runId: string): Promise<void>;
  setTerminal(runId: string, terminal: string): Promise<void>;
  linkSession(runId: string, session: SessionRef): Promise<void>;
  // in seq order
  readEvents(runId: string): Promise<readonly Event[]>;
  readEvent(runId: string, eventId: string): Promise<Event | undefined>;
  // null before init
  readState(runId: string): Promise<State | null>;
  appendEvent(runId: string, input: AppendInput): Promise<Appended>;
  // Only for `yok import-files`: the run, its state and its events as an older yok kept them.
  // Fails when the run id is stored, or with initRun's message when the project holds the name.
  importRun(input: ImportedRun): Promise<Result<void>>;
}

export type ImportedRun = Readonly<{
  run: RunDraft;
  state: State | null;
  events: readonly Event[];
}>;

// exists: the event id was stored already, and that event comes back. conflict: another writer
// stored an event since the caller read, so nothing was written.
export type Appended =
  | Readonly<{ kind: "stored"; event: Event }>
  | Readonly<{ kind: "exists"; event: Event }>
  | Readonly<{ kind: "conflict" }>;

// expectedSeq is the number of events the caller read
export type AppendInput = Readonly<{ event: Event; state: State | null; expectedSeq: number }>;

export interface IProjectRepository {
  list(): Promise<Readonly<Record<string, Project>>>;
  find(name: string): Promise<Project | undefined>;
  // the project at FOLDER, added for the server when there is none
  findOrAddFolder(folder: string): Promise<string>;
  add(name: string, project: Project): Promise<Result<void>>;
  // false when there is no such project; rejects while a run row still points at it
  remove(name: string): Promise<boolean>;
}

// Ids run c1, c2, … within a run, one past the highest stored. Each write reads and writes in one
// transaction, so the server and an orchestrate command can change a run's comments at once.
export interface ICommentRepository {
  list(runId: string): Promise<readonly Comment[]>;
  add(runId: string, drafts: readonly CommentDraft[]): Promise<readonly Comment[]>;
  addUserReply(runId: string, id: string, text: string): Promise<Result<Comment>>;
  // refuses a reply with no text
  reply(runId: string, id: string, reply: AgentReply): Promise<Result<Comment>>;
  // marks the comments still sent as typed, and returns them; one whose thread grew since stays sent
  markDelivered(runId: string, delivered: readonly Comment[]): Promise<readonly Comment[]>;
  // Only for `yok import-files`: keeps the old comment ids, skipping one already stored.
  importComments(runId: string, comments: readonly Comment[]): Promise<void>;
}

export interface ITriggerRepository {
  list(): Promise<readonly Trigger[]>;
  find(project: string, name: string): Promise<Trigger | undefined>;
  // Adds the trigger, or updates the one with the same project, name and workflow (keeping its
  // id and createdAt). Refused when, in the same project, the name belongs to another workflow or
  // the workflow to another name; the error is the trigger it clashes with.
  save(draft: TriggerDraft): Promise<Result<Trigger, Trigger>>;
  remove(id: string): Promise<boolean>;
  // False, and nothing written, if the trigger was removed or its schedule changed since read.
  setNextFireAt(trigger: Trigger, nextFireAt: string): Promise<boolean>;
  // Stores nothing for a trigger removed meanwhile: its fire log went with it.
  appendFire(fire: Fire): Promise<void>;
  // The last LIMIT fires, in the order they were appended.
  readFires(triggerId: string, limit: number): Promise<readonly Fire[]>;
  // Only for `yok import-files`: stores the trigger under its old id; fails when that id is stored.
  importTrigger(trigger: Trigger): Promise<Result<void>>;
}

export type EventDraft = Omit<z.input<typeof EventSchema>, "schemaVersion" | "seq">;

export interface IAuditRepository {
  // Stores the audit run as running, or sets the one this run already holds back to running with
  // this period and commits, keeping its id. Refused, naming the run, when another run holds the
  // project, audit and period. Rejects when the run or the project has no row.
  start(start: AuditStart): Promise<Result<AuditRun>>;
  // Sets the status and makes the audit run's metrics and results exactly the listed ones.
  // Refused, with nothing written, for an unknown audit run or a result id that does not start
  // with `AUDIT_RUN_ID:`.
  finish(auditRunId: string, report: AuditReport): Promise<Result<AuditRun>>;
  // newest period first
  list(project: string, audit: AuditName, filter?: AuditRunFilter): Promise<readonly AuditRun[]>;
  read(auditRunId: string): Promise<AuditRecord | undefined>;
}

export interface IStorage {
  users: IUserRepository;
  runs: IRunRepository;
  projects: IProjectRepository;
  comments: ICommentRepository;
  triggers: ITriggerRepository;
  audits: IAuditRepository;
  close(): Promise<void>;
}
