import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, type IStorage, runDirOf, type State, type WorkflowRun } from "@yok/sdk";
import {
  builtInHandlers,
  type Comment,
  createState,
  projectEvents,
  withStorage,
} from "@yok/sdk/internal";

const addProject = async (storage: IStorage, run: WorkflowRun): Promise<void> => {
  if ((await storage.projects.find(run.project)) !== undefined) return;
  const project = { path: run.cwd, addedBy: { channel: "cli" }, addedAt: run.createdAt };
  const added = await storage.projects.add(run.project, project);
  if (!added.ok) throw new Error(added.error);
};

const addRun = async (
  storage: IStorage,
  run: WorkflowRun,
  state: State | undefined,
): Promise<void> => {
  const { cwd: _cwd, ...draft } = run;
  await storage.runs.addRun(state === undefined ? draft : { ...draft, name: null });
  if (state === undefined || run.name === null) return;
  const named = await storage.runs.initRun(run.id, run.name, state);
  if (!named.ok) throw new Error(named.error);
};

// Runs as `yok run` leaves them in HOME/yok.db; states holds, by run id, the state init gave one.
export const seedRuns = (
  home: string,
  runs: readonly WorkflowRun[],
  states: Readonly<Record<string, State>> = {},
): Promise<void> =>
  withStorage(home, async (storage) => {
    for (const run of runs) {
      await addProject(storage, run);
      await addRun(storage, run, states[run.id]);
    }
  });

// Events stored as given under seq 1, 2, …, for a run with none yet; no handler folds them, and
// the run's state, if it has one, only has its lastEventSeq moved.
export const seedEvents = (home: string, runId: string, events: readonly Event[]): Promise<void> =>
  withStorage(home, async (storage) => {
    const state = await storage.runs.readState(runId);
    for (const [index, event] of events.entries()) {
      const seq = index + 1;
      const appended = await storage.runs.appendEvent(runId, {
        event: { ...event, seq, runId },
        state: state === null ? null : { ...state, lastEventSeq: seq },
        expectedSeq: index,
      });
      if (appended.kind === "conflict") throw new Error(`seeding event ${event.id} conflicted`);
    }
  });

export const savedRun = (home: string, runId: string): Promise<WorkflowRun | undefined> =>
  withStorage(home, (storage) => storage.runs.findRun(runId));

export const savedRuns = (home: string): Promise<readonly WorkflowRun[]> =>
  withStorage(home, (storage) => storage.runs.listRuns());

export const savedState = (home: string, runId: string): Promise<State | null> =>
  withStorage(home, (storage) => storage.runs.readState(runId));

export const savedEvents = (home: string, runId: string): Promise<readonly Event[]> =>
  withStorage(home, (storage) => storage.runs.readEvents(runId));

// The files a yok from before yok.db kept, for the yok import-files tests.

export const gitCheckout = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  // init's first state records HEAD's sha, so the checkout needs a commit
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: dir },
  );
  return dir;
};

export const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, JSON.stringify(value, null, 2));

export type OldRun = Omit<WorkflowRun, "project">;

export const oldRun = (
  id: string,
  name: string | null,
  cwd: string,
  extra: Partial<OldRun> = {},
): OldRun => ({
  id,
  workflow: "ok",
  workflowPath: join(cwd, "ok.yaml"),
  inputs: { task: "fix the login" },
  cwd,
  sessions: [{ agent: "claude", sessionId: "s-1" }],
  name,
  terminal: `claude-${name ?? "unnamed"}`,
  config: null,
  tiers: null,
  createdAt: "2026-02-01T00:00:00.000Z",
  ...extra,
});

export const writeRegistry = (home: string, runs: readonly OldRun[]): void =>
  writeJson(join(home, "registry.json"), {
    version: 1,
    runs: Object.fromEntries(runs.map((run) => [run.id, run])),
  });

export const oldEvent = (runId: string, seq: number, type = "custom.demo.ping"): Event => ({
  schemaVersion: 1,
  seq,
  id: `evt-${runId}-${seq}`,
  ts: `2026-02-01T00:0${seq}:00.000Z`,
  type,
  source: "test",
  runId,
  payload: { seq },
});

export const oldComment = (id: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  file: "artifacts/plan.md",
  kind: "comment",
  text: `about ${id}`,
  status: "sent",
  createdAt: "2026-02-01T00:10:00.000Z",
  thread: [{ by: "user", text: `about ${id}`, at: "2026-02-01T00:10:00.000Z" }],
  ...extra,
});

type RunFolderInput = Readonly<{
  run: OldRun;
  events: readonly Event[];
  // the seq state.json was last written at; the events after it were stored but never folded
  stateSeq?: number;
  comments?: readonly Comment[];
}>;

// A run folder as init and the event store left it: state.json is the first state folded up to
// stateSeq, beside the whole event.jsonl. Returns state.json as written.
export const writeRunFolder = async ({
  run,
  events,
  stateSeq = events.length,
  comments,
}: RunFolderInput): Promise<State> => {
  const dir = runDirOf(run.cwd, run.name ?? "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow.yaml"), "name: ok\n");
  const first = await createState({
    runId: run.id,
    runDir: dir,
    version: "1.0.0",
    eventHandlers: {},
  });
  const state = projectEvents({
    state: first,
    events: events.slice(0, stateSeq),
    handlers: builtInHandlers,
  });
  writeJson(join(dir, "state.json"), state);
  writeFileSync(join(dir, "event.jsonl"), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  if (comments !== undefined) writeJson(join(dir, "comments.json"), { version: 1, comments });
  return state;
};

// A home an older yok left: user u_1a2b3c4d, project app at CHECKOUT, run r-1 (fix-login, 2
// events, 1 comment), run r-2 (old-task) whose folder is gone, trigger t-aaaa1111 and one fire.
export const writeOldHome = async (home: string, checkout: string): Promise<void> => {
  const at = "2026-01-01T00:00:00.000Z";
  writeJson(join(home, "users.json"), {
    u_1a2b3c4d: {
      name: "Ana",
      email: "ana@example.com",
      accounts: { github: { id: 101, login: "ana" } },
    },
  });
  writeJson(join(home, "projects.yaml"), {
    app: { path: checkout, addedBy: { channel: "cli" }, addedAt: at },
  });
  const run = oldRun("r-1", "fix-login", checkout, { user: "u_1a2b3c4d" });
  writeRegistry(home, [run, oldRun("r-2", "old-task", checkout)]);
  await writeRunFolder({
    run,
    events: [oldEvent("r-1", 1), oldEvent("r-1", 2)],
    comments: [oldComment("c1")],
  });
  const trigger = {
    id: "t-aaaa1111",
    name: "digest",
    config: null,
    cron: "0 9 * * *",
    timezone: "UTC",
    nextFireAt: "2026-02-02T09:00:00.000Z",
    createdAt: at,
    project: "app",
    workflow: "task",
  };
  writeJson(join(home, "triggers.json"), { version: 1, triggers: { [trigger.id]: trigger } });
  const fire = {
    triggerId: trigger.id,
    slot: "2026-02-01T09:00:00.000Z",
    status: "started",
    runId: "r-1",
    runName: "fix-login",
    at: "2026-02-01T09:00:01.000Z",
  };
  writeFileSync(join(home, "trigger-fires.jsonl"), `${JSON.stringify(fire)}\n`);
};
