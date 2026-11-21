import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedEvents, seedRuns } from "../../cli/src/test-runs.ts";
import { type Event, type JsonValue, type State, StateSchema } from "./contracts.ts";
import { type RunRef, runDirOf } from "./events.ts";
import type { SessionRef } from "./registry.ts";
import type { IStorage } from "./repositories.ts";
import { requireRun } from "./runs.ts";
import {
  appendRunEvent,
  appendRunEventIf,
  createState,
  type EventHandler,
  type EventHandlers,
  emitRunEvent,
  projectEvents,
  readGit,
  readRunEvents,
  readRunSessions,
  readState,
  syncState,
  toRepoId,
} from "./state.ts";
import { memoryStorage, openStorage } from "./storage.ts";

test("SC216: two conditional appends started together on one state at seq 0: exactly one is stored, the other fails condition-failed", async () => {
  const { run, storage } = await runWithHandlers({});
  const append = (source: string) =>
    appendRunEventIf(
      storage,
      run,
      { type: "custom.once.note", source, payload: null },
      (state) => state?.lastEventSeq === 0,
    );
  const results = await Promise.all([append("first"), append("second")]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toMatchObject({
    ok: false,
    error: "condition-failed",
  });
  expect(await storage.runs.readEvents(run.id)).toHaveLength(1);
});

test("conditional append checks the stored events when the stored state is behind", async () => {
  const { run, storage } = await runWithHandlers({});
  const prior = { ...event(1, "custom.once.note"), id: "already-stored", source: "prior" };
  expect(
    (await storage.runs.appendEvent(run.id, { event: prior, state: null, expectedSeq: 0 })).kind,
  ).toBe("stored");

  const attempted = await appendRunEventIf(
    storage,
    run,
    { type: "custom.once.note", source: "late", payload: null },
    (state) => state?.lastEventSeq === 0,
  );

  expect(attempted).toMatchObject({ ok: false, error: "condition-failed" });
  expect(await storage.runs.readEvents(run.id)).toHaveLength(1);
  expect((await syncState(storage, run.id))?.lastEventSeq).toBe(1);
});

const seed: State = {
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-test",
  runName: "add-login",
  runDir: "/work/.yok/add-login",
  version: "2.0.0",
  workflow: { name: "feature", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: "/work",
    repositories: {
      app: { path: "/work", git: { branch: "b", baseBranch: "main", startSha: "a" } },
    },
  },
  tiers: null,
  nodeRuns: {},
  activeSessions: [],
  eventHandlers: {},
  subscribers: {},
};

const event = (seq: number, type: string, payload: JsonValue = null): Event => ({
  schemaVersion: 1,
  seq,
  id: `evt-${seq}`,
  ts: "2026-09-26T10:00:00Z",
  type,
  source: "test",
  runId: "r-test",
  payload,
});

const handlers: EventHandlers = {
  "workflow.file.opened": (state, opened) => ({
    ...state,
    input: { file: opened.payload },
  }),
};

describe("projectEvents", () => {
  test("folding the same seed, events, and handlers twice yields equal states", () => {
    const events = [
      event(1, "workflow.file.opened", "a.ts"),
      event(2, "workflow.file.opened", "b.ts"),
    ];
    const first = projectEvents({ state: seed, events, handlers });
    expect(first).toEqual(projectEvents({ state: seed, events, handlers }));
    expect(first).toEqual({ ...seed, input: { file: "b.ts" }, lastEventSeq: 2 });
  });

  test("unhandled and custom.* events advance only lastEventSeq", () => {
    const events = [event(1, "workflow.unknown"), event(2, "custom.acme.ping", { x: 1 })];
    expect(projectEvents({ state: seed, events, handlers })).toEqual({ ...seed, lastEventSeq: 2 });
  });

  test("EH5 — the built-in handler runs first, then each extension in listed order on the state the last one returned", () => {
    const seen =
      (label: string): EventHandler =>
      (state) => {
        const before = state.custom?.seen;
        const seenSoFar = Array.isArray(before) ? before : [];
        return { ...state, custom: { seen: [...seenSoFar, `${label}:${state.input.file}`] } };
      };
    const extensions = { "workflow.file.opened": [seen("first"), seen("second")] };
    const events = [event(1, "workflow.file.opened", "a.ts")];

    expect(projectEvents({ state: seed, events, handlers, extensions }).custom).toEqual({
      seen: ["first:a.ts", "second:a.ts"],
    });
  });

  test("EH6 — a custom.* event reaches the extension handlers registered for its type", () => {
    const extensions = {
      "custom.review.note": [
        (state: State, note: Event): State => ({ ...state, custom: { note: note.payload } }),
      ],
    };
    const events = [event(1, "custom.review.note", "looks good")];

    expect(projectEvents({ state: seed, events, handlers, extensions })).toEqual({
      ...seed,
      custom: { note: "looks good" },
      lastEventSeq: 1,
    });
  });

  test("events at or below lastEventSeq are skipped", () => {
    const state = { ...seed, lastEventSeq: 1, input: { file: "kept.ts" } };
    const events = [event(1, "workflow.file.opened", "old.ts")];
    expect(projectEvents({ state, events, handlers })).toEqual(state);
  });

  test("a handler that returns an invalid state throws", () => {
    const broken: EventHandlers = {
      "workflow.broken": (state) => ({ ...state, runName: "Not A Slug" }),
    };
    expect(() =>
      projectEvents({ state: seed, events: [event(1, "workflow.broken")], handlers: broken }),
    ).toThrow(/runName/);
  });
});

describe("syncState", () => {
  test("a stored state behind its events catches up from the events stored after its seq", async () => {
    const { run, storage } = await runWithHandlers({});
    const opened = (seq: number, file: string): Event => event(seq, "workflow.file.opened", file);
    await storage.runs.appendEvent(run.id, {
      event: opened(1, "a.ts"),
      state: { ...seed, lastEventSeq: 1 },
      expectedSeq: 0,
    });
    await storage.runs.appendEvent(run.id, {
      event: opened(2, "b.ts"),
      state: null,
      expectedSeq: 1,
    });
    await storage.runs.appendEvent(run.id, {
      event: opened(3, "c.ts"),
      state: null,
      expectedSeq: 2,
    });

    expect(await syncState(storage, run.id)).toEqual({ ...seed, lastEventSeq: 3 });
    expect((await storage.runs.readState(run.id))?.lastEventSeq).toBe(1);
  });
});

const HANDLER_MODULE = `export const onReviewNote = (state, event) => ({ ...state, custom: { ...state.custom, note: event.payload } });
export const onStarted = (state) => ({ ...state, custom: { ...state.custom, input: state.input } });
export const notAFunction = 1;
export const onRisky = (state, event) => {
  if (event.payload === "bad") throw new Error("cannot apply a bad note");
  return { ...state, custom: { ...state.custom, note: event.payload } };
};
`;

const seedRun = async (storage: IStorage, run: RunRef, state: State): Promise<void> => {
  const addedAt = new Date().toISOString();
  await storage.projects.add("repo", { path: run.cwd, addedBy: { channel: "cli" }, addedAt });
  await storage.runs.addRun({
    id: run.id,
    project: "repo",
    workflow: "feature",
    workflowPath: join(run.cwd, "workflow.yaml"),
    inputs: {},
    sessions: [],
    name: null,
    terminal: null,
    config: null,
    tiers: null,
    createdAt: addedAt,
  });
  const claimed = await storage.runs.initRun(run.id, run.name, state);
  if (!claimed.ok) throw new Error(claimed.error);
};

// A run stored with a state that lists the given handlers from a module written beside it.
const runWithHandlers = async (
  refs: Readonly<Record<string, readonly { module?: string; handler: string }[]>>,
) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "handlers-")));
  const module = join(cwd, "review-state.ts");
  await writeFile(module, HANDLER_MODULE);
  const eventHandlers = Object.fromEntries(
    Object.entries(refs).map(([type, list]) => [
      type,
      list.map((ref) => ({ module: ref.module ?? module, handler: ref.handler })),
    ]),
  );
  const run = { id: "r-test", cwd, name: "fix-login" };
  const runDir = runDirOf(cwd, run.name);
  await mkdir(runDir, { recursive: true });
  const storage = memoryStorage();
  await seedRun(storage, run, { ...seed, eventHandlers });
  const savedState = async (): Promise<State> => {
    const state = await storage.runs.readState(run.id);
    if (state === null) throw new Error("no state");
    return state;
  };
  return { run, runDir, storage, savedState };
};

describe("emitRunEvent", () => {
  test.each(["workflow.node.completed", "orchestrate.done", "hooks.session-start.called"])(
    "SC8: refuses the engine-owned %s and leaves the log untouched",
    async (type) => {
      const { run, storage } = await runWithHandlers({});

      const result = await emitRunEvent(run, { type, source: "ext", payload: {} }, storage);

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error).toStartWith(type);
      expect(await storage.runs.readEvents(run.id)).toHaveLength(0);
    },
  );
});

describe("emitRunEvent with extension handlers", () => {
  test("EH7 — a custom.* event's extension handler writes state.custom into state.json", async () => {
    const { run, storage, savedState } = await runWithHandlers({
      "custom.review.note": [{ handler: "onReviewNote" }],
    });

    const result = await emitRunEvent(
      run,
      {
        type: "custom.review.note",
        source: "test",
        payload: "looks good",
      },
      storage,
    );

    expect(result.ok).toBe(true);
    expect((await savedState()).custom).toEqual({ note: "looks good" });
  });

  test("EH8 — an extension on a built-in type sees the state the built-in handler wrote", async () => {
    const { run, storage, savedState } = await runWithHandlers({
      "workflow.started": [{ handler: "onStarted" }],
    });

    await appendRunEvent(storage, run, {
      type: "workflow.started",
      source: "test",
      payload: { workflow: "feature", inputs: { ticket: "T-1" } },
    });

    expect((await savedState()).custom).toEqual({ input: { ticket: "T-1" } });
  });

  test.each([
    [
      "a module that does not exist",
      { module: "/nowhere/review-state.ts", handler: "onReviewNote" },
      "/nowhere/review-state.ts",
    ],
    ["an export that is missing", { handler: "onMissing" }, "onMissing"],
    ["an export that is not a function", { handler: "notAFunction" }, "notAFunction"],
  ])("EH9 — %s fails the emit, naming it, and stores nothing", async (_label, ref, named) => {
    const { run, storage, savedState } = await runWithHandlers({ "custom.review.note": [ref] });

    const result = await emitRunEvent(
      run,
      {
        type: "custom.review.note",
        source: "test",
        payload: "looks good",
      },
      storage,
    );

    expect(result.ok ? "" : result.error).toContain(named);
    expect(result.ok ? "" : result.error).toContain(ref.handler);
    expect(await storage.runs.readEvents(run.id)).toEqual([]);
    expect((await savedState()).lastEventSeq).toBe(0);
  });

  test.each([["throws", "onRisky"]])(
    "EH13 — a handler that %s fails the emit and stores nothing, so later events still apply",
    async (_label, handler) => {
      const { run, storage, savedState } = await runWithHandlers({
        "custom.review.note": [{ handler }],
        "custom.review.other": [{ handler: "onReviewNote" }],
      });

      const bad = await emitRunEvent(
        run,
        {
          type: "custom.review.note",
          source: "test",
          payload: "bad",
        },
        storage,
      );
      const good = await emitRunEvent(
        run,
        {
          type: "custom.review.other",
          source: "test",
          payload: "fine",
        },
        storage,
      );

      expect(bad.ok ? "" : bad.error).toContain("event not stored");
      expect(good.ok).toBe(true);
      expect((await storage.runs.readEvents(run.id)).map((event) => event.type)).toEqual([
        "custom.review.other",
      ]);
      expect(await savedState()).toMatchObject({ lastEventSeq: 1, custom: { note: "fine" } });
    },
  );

  test("SC205: an event its handler throws on is refused, and the run keeps no event and its state as before", async () => {
    const { run, storage, savedState } = await runWithHandlers({
      "custom.review.note": [{ handler: "onRisky" }],
    });
    const before = await savedState();

    const result = await emitRunEvent(
      run,
      { type: "custom.review.note", source: "test", payload: "bad" },
      storage,
    );

    expect(result.ok ? "" : result.error).toContain(
      "event not stored, a handler could not apply it",
    );
    expect(await storage.runs.readEvents(run.id)).toEqual([]);
    expect(await savedState()).toEqual(before);
  });

  test("EH14 — a handler module that throws while loading fails the emit and stores nothing", async () => {
    const broken = join(await realpath(await mkdtemp(join(tmpdir(), "broken-"))), "broken.ts");
    await writeFile(
      broken,
      'throw new Error("module is broken");\nexport const onReviewNote = () => {};\n',
    );
    const { run, storage } = await runWithHandlers({
      "custom.review.note": [{ module: broken, handler: "onReviewNote" }],
    });

    const result = await emitRunEvent(
      run,
      {
        type: "custom.review.note",
        source: "test",
        payload: "looks good",
      },
      storage,
    );

    expect(result.ok ? "" : result.error).toContain("module is broken");
    expect(await storage.runs.readEvents(run.id)).toEqual([]);
  });
});

const repoIn = async (name: string): Promise<string> => {
  const repo = join(await realpath(await mkdtemp(join(tmpdir(), "state-"))), name);
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
};

describe("createState", () => {
  test("SC18: builds a valid first state from the run folder and the frozen handler list, and writes no file", async () => {
    const repo = await repoIn("Fix Login App");
    const runDir = join(repo, ".yok", "fix-login");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "workflow.yaml"), "name: demo\nnodes: []\n");

    const eventHandlers = { "custom.review.note": [{ module: "/abs/review.ts", handler: "f" }] };

    const state = await createState({
      runId: "r-42",
      runDir,
      version: "1.0.0",
      eventHandlers,
    });

    expect(StateSchema.safeParse(state).success).toBe(true);
    expect(state).toMatchObject({
      lastEventSeq: 0,
      runId: "r-42",
      runName: "fix-login",
      runDir,
      version: "1.0.0",
      workflow: { name: "demo", path: "workflow.yaml" },
      input: {},
      scope: null,
      completedAt: null,
      status: "running",
      eventHandlers,
    });
    expect(state).not.toHaveProperty("custom");
    expect(state).not.toHaveProperty("options");
    expect(state).not.toHaveProperty("currentFile");
    expect(state.workspace.type).toBe("mono");
    expect(state.workspace.path).toBe(repo);
    expect(Object.keys(state.workspace.repositories)).toEqual(["fix-login-app"]);
    expect(await readdir(runDir)).toEqual(["workflow.yaml"]);
  });
});

describe("readGit", () => {
  test("SC21: baseBranch equals branch when the repo has no origin", async () => {
    const git = await readGit(await repoIn("repo"));

    expect(git.branch).toBe("main");
    expect(git.baseBranch).toBe(git.branch);
  });
});

test.each([
  ["apiServer", "api-server"],
  ["api", "api"],
  ["My_Repo.v2", "my-repo-v2"],
  ["harness-engineering", "harness-engineering"],
  ["___", "repo"],
])("WS16 — toRepoId(%s) is %s", (name, id) => {
  expect(toRepoId(name)).toBe(id);
});

describe("state files written before activeSessions", () => {
  test("SC9: a state without activeSessions loads with it empty and every other field unchanged", () => {
    const { activeSessions: _omitted, ...legacy } = seed;

    const parsed = StateSchema.parse(legacy);

    expect(parsed).toEqual(seed);
  });
});

describe("what subscribers keep in the run's state", () => {
  test("SC211: notification.thread.started fills state.notification, custom.state.updated merges into state.custom by key, and a call record changes neither", async () => {
    const { run, storage, savedState } = await runWithHandlers({});

    for (const input of [
      { type: "custom.state.updated", source: "subscriber", payload: { asana: { taskId: "555" } } },
      {
        type: "notification.thread.started",
        source: "notifier",
        payload: { provider: "slack", threadId: "171.1" },
      },
      {
        type: "custom.state.updated",
        source: "subscriber",
        payload: { linear: { issue: "VER-1" } },
      },
      { type: "custom.state.updated", source: "subscriber", payload: { asana: { taskId: "777" } } },
      {
        id: "subscriber:evt-1:asana",
        type: "subscriber.called",
        source: "subscriber",
        payload: {
          subscriber: "asana",
          eventId: "evt-1",
          eventSeq: 1,
          eventType: "workflow.node.started",
          blocking: true,
          status: "ok",
          durationMs: 3,
          output: { taskId: "999" },
        },
      },
    ]) {
      const appended = await appendRunEvent(storage, run, input);
      if (!appended.ok) throw new Error(appended.error);
    }

    const state = await savedState();
    expect(state.notification).toEqual({ provider: "slack", threadId: "171.1" });
    expect(state.custom).toEqual({ asana: { taskId: "777" }, linear: { issue: "VER-1" } });
  });

  test("SC919: a thread started with channel C1 and requester U7 keeps both in state.notification", async () => {
    const { run, storage, savedState } = await runWithHandlers({});

    const appended = await appendRunEvent(storage, run, {
      type: "notification.thread.started",
      source: "orchestrate",
      payload: { provider: "slack", threadId: "100.1", channel: "C1", user: "U7" },
    });

    if (!appended.ok) throw new Error(appended.error);
    expect((await savedState()).notification).toEqual({
      provider: "slack",
      threadId: "100.1",
      channel: "C1",
      user: "U7",
    });
  });

  test("SC920: a thread event with an empty channel is refused, so no empty value reaches the notifier", async () => {
    const { run, storage } = await runWithHandlers({});

    const appended = await appendRunEvent(storage, run, {
      type: "notification.thread.started",
      source: "orchestrate",
      payload: { provider: "slack", threadId: "100.1", channel: "" },
    });

    expect(appended.ok).toBe(false);
  });
});

const PING = { type: "custom.demo.ping", source: "test", payload: null };

describe("storing events through storage", () => {
  test("SC204: an append that conflicts every time fails after forty tries and calls no subscriber", async () => {
    const real = memoryStorage();
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "conflict-")));
    const run = { id: "r-1", cwd, name: "fix-login" };
    const marker = join(cwd, "called");
    const listener = {
      name: "listener",
      blocking: true,
      timeoutSeconds: 5,
      command: `touch ${marker}`,
      cwd,
    };
    await seedRun(real, run, {
      ...seed,
      runId: run.id,
      subscribers: { "custom.demo.ping": [listener] },
    });
    let appends = 0;
    const storage: IStorage = {
      ...real,
      runs: {
        ...real.runs,
        appendEvent: async () => {
          appends += 1;
          return { kind: "conflict" };
        },
      },
    };

    const result = await appendRunEvent(storage, run, PING);

    expect(result).toEqual({
      ok: false,
      error: "event not stored: run r-1 changed during 40 tries",
    });
    expect(appends).toBe(40);
    expect(await readdir(cwd)).not.toContain("called");
  });

  test.each([
    ["SC201: five processes each storing five events on one run", 5, 5, 0],
    ["twenty processes each storing ten events on a run already holding 300", 20, 10, 300],
  ])(
    "%s all land, numbered in order, with the state matching the events",
    async (_label, processes, each, stored) => {
      const home = await realpath(await mkdtemp(join(tmpdir(), "concurrent-home-")));
      const cwd = await realpath(await mkdtemp(join(tmpdir(), "concurrent-")));
      const run = { id: "r-1", cwd, name: "fix-login" };
      const storage = openStorage(home);
      await seedRun(storage, run, { ...seed, runId: run.id });
      for (let i = 0; i < stored; i++) await appendRunEvent(storage, run, PING);
      const writer = (source: string) => `
      import { appendRunEvent } from ${JSON.stringify(join(import.meta.dir, "state.ts"))};
      import { openStorage } from ${JSON.stringify(join(import.meta.dir, "storage.ts"))};
      const storage = openStorage(${JSON.stringify(home)});
      for (let i = 0; i < ${each}; i++) {
        const stored = await appendRunEvent(storage, ${JSON.stringify(run)}, {
          type: "custom.demo.ping", source: ${JSON.stringify(source)}, payload: i,
        });
        if (!stored.ok) { console.error(stored.error); process.exit(1); }
      }
      await storage.close();
    `;
      const writers = Array.from({ length: processes }, (_, i) =>
        Bun.spawn(["bun", "-e", writer(`p${i}`)], { stdout: "pipe", stderr: "pipe" }),
      );
      const exits = await Promise.all(writers.map((writer) => writer.exited));
      const errors = await Promise.all(writers.map((writer) => new Response(writer.stderr).text()));

      expect({ exits, errors }).toEqual({
        exits: writers.map(() => 0),
        errors: writers.map(() => ""),
      });
      const total = stored + processes * each;
      const events = await storage.runs.readEvents(run.id);
      expect(events.map((event) => event.seq)).toEqual(
        Array.from({ length: total }, (_, i) => i + 1),
      );
      const state = await storage.runs.readState(run.id);
      expect(state?.lastEventSeq).toBe(total);
      expect(await syncState(storage, run.id)).toEqual(state);
      await storage.close();
    },
    60_000,
  );

  test("SC224: a skill script finds its run, stores an event and reads the state back with no storage, through YOK_HOME", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "skill-home-")));
    const repo = await repoIn("repo");
    const run = { id: "r-1", cwd: repo, name: "feat-x" };
    await mkdir(runDirOf(repo, run.name), { recursive: true });
    const seeded = openStorage(home);
    await seedRun(seeded, run, { ...seed, runId: run.id, runName: run.name, lastEventSeq: 0 });
    await seeded.close();
    const previous = process.env.YOK_HOME;
    process.env.YOK_HOME = home;
    try {
      const found = await requireRun({ name: "feat-x", env: process.env, cwd: repo });
      expect(found).toEqual({ ok: true, value: run });
      if (!found.ok) return;
      const note = { type: "custom.skill.note", source: "skill", payload: "hi" };
      const stored = await emitRunEvent(found.value, note);
      expect(stored.ok ? stored.value.seq : stored.error).toBe(1);
      expect((await readState(found.value))?.lastEventSeq).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.YOK_HOME;
      else process.env.YOK_HOME = previous;
    }
    const reader = Bun.spawn(
      [
        "bun",
        "-e",
        `import { openStorage } from ${JSON.stringify(join(import.meta.dir, "storage.ts"))};
         const storage = openStorage(${JSON.stringify(home)});
         console.log((await storage.runs.readState("r-1")).lastEventSeq);
         await storage.close();`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await reader.exited).toBe(0);
    expect((await new Response(reader.stdout).text()).trim()).toBe("1");
    await rm(home, { recursive: true, force: true });
  });

  test("SC413: a run's three events and its claude A, codex B sessions read the same with and without a storage, and an unknown run reads empty", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "readers-home-")));
    const cwd = await repoIn("readers");
    const sessions: SessionRef[] = [
      { agent: "claude", sessionId: "A" },
      { agent: "codex", sessionId: "B" },
    ];
    await seedRuns(home, [
      {
        id: "r-1",
        project: "readers",
        workflow: "task",
        workflowPath: join(cwd, "task.yaml"),
        inputs: {},
        cwd,
        sessions,
        name: "feat-x",
        terminal: null,
        config: null,
        tiers: null,
        createdAt: "2026-09-26T10:00:00Z",
      },
    ]);
    const events = [1, 2, 3].map((seq) => ({
      ...event(seq, "custom.test.note", seq),
      runId: "r-1",
    }));
    await seedEvents(home, "r-1", events);
    const run = { id: "r-1", cwd, name: "feat-x" };
    const unknown = { ...run, id: "r-9" };
    const previous = process.env.YOK_HOME;
    process.env.YOK_HOME = home;
    try {
      expect(await readRunEvents(run)).toEqual(events);
      expect(await readRunSessions(run)).toEqual(sessions);
      expect(await readRunEvents(unknown)).toEqual([]);
      expect(await readRunSessions(unknown)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.YOK_HOME;
      else process.env.YOK_HOME = previous;
    }
    const storage = openStorage(home);
    expect(await readRunEvents(run, storage)).toEqual(events);
    expect(await readRunSessions(run, storage)).toEqual(sessions);
    expect(await readRunEvents(unknown, storage)).toEqual([]);
    expect(await readRunSessions(unknown, storage)).toEqual([]);
    await storage.close();
    await rm(home, { recursive: true, force: true });
  });
});
