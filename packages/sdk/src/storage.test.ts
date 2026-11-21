import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, NodeRun, State } from "./contracts.ts";
import type { CommentDraft } from "./events.ts";
import type { Project, RunDraft } from "./registry.ts";
import type { IStorage } from "./repositories.ts";
import { memoryStorage, openStorage } from "./storage.ts";

const TABLES = [
  "artifacts",
  "comments",
  "events",
  "projects",
  "runs",
  "trigger_fires",
  "triggers",
  "user_accounts",
  "users",
];

const homes: string[] = [];
const freshHome = (): string => {
  const root = mkdtempSync(join(tmpdir(), "yok-storage-"));
  homes.push(root);
  return join(root, "home");
};
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const mode = (path: string): number => statSync(path).mode & 0o777;

const readPragma = (path: string, pragma: string): unknown => {
  const db = new Database(path, { readonly: true });
  try {
    return Object.values(db.query(`PRAGMA ${pragma}`).get() ?? {})[0];
  } finally {
    db.close();
  }
};

const tablesIn = (path: string): readonly string[] => {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
};

const runBun = (code: string) => Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" });

const STORAGE_TS = join(import.meta.dir, "storage.ts");

const RITESH = {
  id: 8675309,
  login: "ritesh-gh",
  name: "Ritesh",
  email: "r@example.com",
  token: "gho_a",
};

describe("opening yok.db", () => {
  test("SC107: a fresh home gets yok.db, -wal and -shm at mode 0600 in a 0700 home, WAL, foreign keys and all nine tables", async () => {
    const home = freshHome();
    const storage = openStorage(home);
    const db = join(home, "yok.db");
    expect(mode(home)).toBe(0o700);
    for (const file of [db, `${db}-wal`, `${db}-shm`]) expect(mode(file)).toBe(0o600);
    expect(readPragma(db, "user_version")).toBe(1);
    expect(readPragma(db, "journal_mode")).toBe("wal");
    expect(tablesIn(db)).toEqual(TABLES);
    // foreign_keys is a per-connection setting, so it is proved through the storage's own one
    await expect(
      storage.users.addUserAccount("u_missing", { provider: "slack", providerId: "U1" }),
    ).rejects.toThrow("FOREIGN KEY");
    await storage.close();
  });

  test("SC108: reopening a yok.db whose three files another program made 0644 sets each back to 0600", async () => {
    const home = freshHome();
    await openStorage(home).close();
    const db = join(home, "yok.db");
    const first = openStorage(home);
    for (const file of [db, `${db}-wal`, `${db}-shm`]) chmodSync(file, 0o644);
    const second = openStorage(home);
    for (const file of [db, `${db}-wal`, `${db}-shm`]) expect(mode(file)).toBe(0o600);
    await second.close();
    await first.close();
  });

  test("SC109: reopening a migrated home migrates nothing and keeps the saved user", async () => {
    const home = freshHome();
    const first = openStorage(home);
    const saved = await first.users.saveGitHubUser(RITESH);
    await first.close();
    const second = openStorage(home);
    expect(readPragma(join(home, "yok.db"), "user_version")).toBe(1);
    expect(await second.users.list()).toEqual([saved]);
    await second.close();
  });

  test("SC110: a yok.db at user_version 2 is refused as written by a newer yok and left at 2", async () => {
    const home = freshHome();
    await openStorage(home).close();
    const path = join(home, "yok.db");
    const raw = new Database(path);
    raw.run("PRAGMA user_version = 2");
    raw.close();
    expect(() => openStorage(home)).toThrow(
      "yok.db was written by a newer yok (schema 2); update yok",
    );
    expect(readPragma(path, "user_version")).toBe(2);
  });

  test("SC111: four processes opening one fresh home at once all exit 0 and leave it migrated once", async () => {
    const home = freshHome();
    const code = `const { openStorage } = await import(${JSON.stringify(STORAGE_TS)}); await openStorage(${JSON.stringify(home)}).close();`;
    const procs = [1, 2, 3, 4].map(() => runBun(code));
    const exits = await Promise.all(procs.map((proc) => proc.exited));
    const errors = await Promise.all(procs.map((proc) => new Response(proc.stderr).text()));
    expect({ exits, errors }).toEqual({ exits: [0, 0, 0, 0], errors: ["", "", "", ""] });
    const path = join(home, "yok.db");
    expect(readPragma(path, "user_version")).toBe(1);
    expect(tablesIn(path)).toEqual(TABLES);
  });
});

describe("users", () => {
  let storage: IStorage;
  afterEach(async () => {
    await storage.close();
  });

  test("SC113: a first GitHub sign-in stores a u_ id and reads back in today's user shape from list, find and findByAccount", async () => {
    storage = memoryStorage();
    const [id, user] = await storage.users.saveGitHubUser(RITESH);
    expect(id).toMatch(/^u_[0-9a-f]{8}$/);
    const expected = {
      name: "Ritesh",
      email: "r@example.com",
      accounts: { github: { id: 8675309, login: "ritesh-gh", token: "gho_a" } },
    };
    expect(user).toEqual(expected);
    expect(await storage.users.list()).toEqual([[id, expected]]);
    expect(await storage.users.find(id)).toEqual(expected);
    expect(await storage.users.findByAccount("github", "8675309")).toEqual([id, expected]);
  });

  test("SC114: signing in again with the same GitHub id keeps the user id and takes the new name, login and token", async () => {
    storage = memoryStorage();
    const [id] = await storage.users.saveGitHubUser(RITESH);
    const again = { ...RITESH, name: "Ritesh K", login: "ritesh-k", token: "gho_b" };
    const [sameId, user] = await storage.users.saveGitHubUser(again);
    expect(sameId).toBe(id);
    expect(user).toEqual({
      name: "Ritesh K",
      email: "r@example.com",
      accounts: { github: { id: 8675309, login: "ritesh-k", token: "gho_b" } },
    });
    expect(await storage.users.list()).toHaveLength(1);
  });

  test("SC115: two processes signing in GitHub id 42 for the first time at once make one user", async () => {
    const home = freshHome();
    storage = openStorage(home);
    const signIn = { id: 42, login: "asha", name: "Asha", email: "", token: "gho_x" };
    const code = `const { openStorage } = await import(${JSON.stringify(STORAGE_TS)}); const s = openStorage(${JSON.stringify(home)}); const [id] = await s.users.saveGitHubUser(${JSON.stringify(signIn)}); await s.close(); process.stdout.write(id);`;
    const procs = [runBun(code), runBun(code)];
    expect(await Promise.all(procs.map((proc) => proc.exited))).toEqual([0, 0]);
    const ids = await Promise.all(procs.map((proc) => new Response(proc.stdout).text()));
    expect(ids[0]).toMatch(/^u_/);
    expect(ids[1]).toBe(ids[0] ?? "");
    expect((await storage.users.list()).map(([id]) => id)).toEqual([ids[0] ?? ""]);
  });

  test("SC116: adding a Slack account user A holds to user B moves it to B and leaves A's GitHub account and token", async () => {
    storage = memoryStorage();
    const [a] = await storage.users.saveGitHubUser(RITESH);
    const [b] = await storage.users.saveGitHubUser({
      ...RITESH,
      id: 2,
      login: "asha",
      name: "Asha",
      token: "gho_b",
    });
    await storage.users.addUserAccount(a, { provider: "slack", providerId: "U7" });
    await storage.users.addUserAccount(b, { provider: "slack", providerId: "U7" });
    expect((await storage.users.findByAccount("slack", "U7"))?.[0]).toBe(b);
    expect(await storage.users.find(a)).toEqual({
      name: "Ritesh",
      email: "r@example.com",
      accounts: { github: { id: 8675309, login: "ritesh-gh", token: "gho_a" } },
    });
    expect(await storage.users.find(b)).toEqual({
      name: "Asha",
      email: "r@example.com",
      accounts: { github: { id: 2, login: "asha", token: "gho_b" } },
      slack: "U7",
    });
  });

  test("SC117: adding a GitHub account the user has replaces it whole: no token drops it, a new token sets it", async () => {
    storage = memoryStorage();
    const [id] = await storage.users.saveGitHubUser({ ...RITESH, id: 1, login: "a" });
    await storage.users.addUserAccount(id, { provider: "github", providerId: "1", username: "a" });
    expect((await storage.users.find(id))?.accounts.github).toEqual({ id: 1, login: "a" });
    const withToken = { provider: "github", providerId: "1", username: "a", token: "gho_b" };
    await storage.users.addUserAccount(id, withToken);
    expect((await storage.users.find(id))?.accounts.github).toEqual({
      id: 1,
      login: "a",
      token: "gho_b",
    });
    expect(await storage.users.list()).toHaveLength(1);
  });

  test("SC118: removing the Slack account leaves GitHub as it was, and removing it again changes nothing", async () => {
    storage = memoryStorage();
    const [id, signedIn] = await storage.users.saveGitHubUser(RITESH);
    await storage.users.addUserAccount(id, { provider: "slack", providerId: "U7" });
    await storage.users.removeUserAccount(id, "slack");
    expect(await storage.users.find(id)).toEqual(signedIn);
    expect(await storage.users.findByAccount("slack", "U7")).toBeUndefined();
    await storage.users.removeUserAccount(id, "slack");
    expect(await storage.users.find(id)).toEqual(signedIn);
  });

  test("SC119: lookups for nobody are undefined, an account for a missing user rejects and moves nothing, and a fresh store lists []", async () => {
    storage = memoryStorage();
    expect(await storage.users.list()).toEqual([]);
    const [a] = await storage.users.saveGitHubUser(RITESH);
    await storage.users.addUserAccount(a, { provider: "slack", providerId: "U7" });
    expect(await storage.users.find("u_missing")).toBeUndefined();
    expect(await storage.users.findByAccount("github", "999")).toBeUndefined();
    expect(await storage.users.findByAccount("slack", "U9")).toBeUndefined();
    await expect(
      storage.users.addUserAccount("u_missing", { provider: "slack", providerId: "U7" }),
    ).rejects.toThrow();
    expect((await storage.users.findByAccount("slack", "U7"))?.[0]).toBe(a);
  });
});

const AT = "2026-11-19T10:00:00.000Z";

const PROJECT = { path: "/abs/repo", addedBy: { channel: "cli" }, addedAt: AT };

const draft = (id: string, extra: Partial<RunDraft> = {}): RunDraft => ({
  id,
  project: "repo",
  workflow: "feature",
  workflowPath: "/abs/repo/workflow.yaml",
  inputs: { task: "t" },
  sessions: [],
  name: null,
  terminal: null,
  config: null,
  tiers: null,
  createdAt: AT,
  ...extra,
});

const state = (runId: string, name: string, extra: Partial<State> = {}): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId,
  runName: name,
  runDir: `/abs/repo/.yok/${name}`,
  version: "2.0.0",
  workflow: { name: "feature", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: AT,
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: "/abs/repo",
    repositories: {
      app: { path: "/abs/repo", git: { branch: "b", baseBranch: "main", startSha: "a" } },
    },
  },
  tiers: null,
  nodeRuns: {},
  activeSessions: [],
  eventHandlers: {},
  subscribers: {},
  ...extra,
});

const event = (runId: string, seq: number, id = `evt-${seq}`): Event => ({
  schemaVersion: 1,
  seq,
  id,
  ts: AT,
  type: "custom.demo.ping",
  source: "test",
  runId,
  payload: null,
});

const seedRun = async (storage: IStorage, id = "r-1", name = "feat-x"): Promise<void> => {
  await storage.projects.add("repo", PROJECT);
  await storage.runs.addRun(draft(id));
  const claimed = await storage.runs.initRun(id, name, state(id, name));
  if (!claimed.ok) throw new Error(claimed.error);
};

describe("runs, events and projects", () => {
  let storage: IStorage;
  afterEach(async () => {
    await storage.close();
  });

  test("SC203: an append whose expectedSeq is stale replies conflict and writes nothing; the current seq stores it, and its id again replies exists", async () => {
    storage = memoryStorage();
    await seedRun(storage);
    const first = await storage.runs.appendEvent("r-1", {
      event: event("r-1", 1),
      state: state("r-1", "feat-x", { lastEventSeq: 1 }),
      expectedSeq: 0,
    });
    expect(first.kind).toBe("stored");
    const before = await storage.runs.readState("r-1");
    const second = event("r-1", 2);
    const next = state("r-1", "feat-x", { lastEventSeq: 2 });
    expect(
      await storage.runs.appendEvent("r-1", { event: second, state: next, expectedSeq: 0 }),
    ).toEqual({
      kind: "conflict",
    });
    expect((await storage.runs.readEvents("r-1")).map((stored) => stored.seq)).toEqual([1]);
    expect(await storage.runs.readState("r-1")).toEqual(before);
    expect(
      await storage.runs.appendEvent("r-1", { event: second, state: next, expectedSeq: 1 }),
    ).toEqual({
      kind: "stored",
      event: second,
    });
    const again = { ...event("r-1", 3), id: second.id };
    expect(
      await storage.runs.appendEvent("r-1", { event: again, state: next, expectedSeq: 2 }),
    ).toEqual({
      kind: "exists",
      event: second,
    });
  });

  test("SC206: a run reads back with its project's folder as cwd, and source, user, policies and permissionMode stay absent", async () => {
    storage = memoryStorage();
    await storage.projects.add("repo", PROJECT);
    await storage.runs.addRun(draft("r-1"));
    const found = await storage.runs.findRun("r-1");
    expect(found).toEqual({ ...draft("r-1"), cwd: "/abs/repo" });
    expect(found !== undefined && "source" in found).toBe(false);
    expect(found !== undefined && "user" in found).toBe(false);
    expect(found !== undefined && "policies" in found).toBe(false);
    expect(found !== undefined && "permissionMode" in found).toBe(false);
    expect(await storage.runs.listRuns()).toEqual([{ ...draft("r-1"), cwd: "/abs/repo" }]);
    expect(await storage.runs.findRun("nope")).toBeUndefined();
  });

  test("SC207: a run whose project row is gone is rejected and not stored", async () => {
    storage = memoryStorage();
    await expect(storage.runs.addRun(draft("r-1", { project: "gone" }))).rejects.toThrow();
    expect(await storage.runs.listRuns()).toEqual([]);
  });

  test("SC208: init refuses a name another run of the project holds, allows it in another project, and fails for an unknown run", async () => {
    storage = memoryStorage();
    await seedRun(storage, "r-1", "feat-x");
    await storage.projects.add("other", { ...PROJECT, path: "/abs/other" });
    await storage.runs.addRun(draft("r-2"));
    await storage.runs.addRun(
      draft("r-3", { project: "other", createdAt: "2026-11-19T11:00:00.000Z" }),
    );
    expect(await storage.runs.initRun("r-2", "feat-x", state("r-2", "feat-x"))).toEqual({
      ok: false,
      error: "run name feat-x is taken in project repo",
    });
    expect((await storage.runs.findRun("r-2"))?.name).toBeNull();
    expect(await storage.runs.readState("r-2")).toBeNull();
    expect((await storage.runs.initRun("r-3", "feat-x", state("r-3", "feat-x"))).ok).toBe(true);
    expect((await storage.runs.findRunsByName("feat-x")).map((run) => run.id)).toEqual([
      "r-3",
      "r-1",
    ]);
    expect(await storage.runs.initRun("r-9", "feat-z", state("r-9", "feat-z"))).toEqual({
      ok: false,
      error: "run r-9 not found",
    });
  });

  test("SC209: linking the same session twice records it once, and the same id under another agent is a second session", async () => {
    storage = memoryStorage();
    await seedRun(storage);
    await storage.runs.linkSession("r-1", { agent: "claude", sessionId: "s1" });
    await storage.runs.linkSession("r-1", { agent: "claude", sessionId: "s1" });
    await storage.runs.linkSession("r-1", { agent: "codex", sessionId: "s1" });
    expect((await storage.runs.findRun("r-1"))?.sessions).toEqual([
      { agent: "claude", sessionId: "s1" },
      { agent: "codex", sessionId: "s1" },
    ]);
  });

  test("SC210: removing a run with two stored events takes the run and its events", async () => {
    storage = memoryStorage();
    await seedRun(storage);
    await storage.runs.appendEvent("r-1", { event: event("r-1", 1), state: null, expectedSeq: 0 });
    await storage.runs.appendEvent("r-1", { event: event("r-1", 2), state: null, expectedSeq: 1 });
    await storage.runs.removeRun("r-1");
    expect(await storage.runs.findRun("r-1")).toBeUndefined();
    expect(await storage.runs.readEvents("r-1")).toEqual([]);
  });

  test("readEvent finds r-1's evt-2 by its id, and nothing for an unknown id or for evt-2 asked of r-2", async () => {
    storage = memoryStorage();
    await seedRun(storage);
    await storage.runs.appendEvent("r-1", { event: event("r-1", 1), state: null, expectedSeq: 0 });
    await storage.runs.appendEvent("r-1", { event: event("r-1", 2), state: null, expectedSeq: 1 });

    expect(await storage.runs.readEvent("r-1", "evt-2")).toEqual(event("r-1", 2));
    expect(await storage.runs.readEvent("r-1", "evt-9")).toBeUndefined();
    expect(await storage.runs.readEvent("r-2", "evt-2")).toBeUndefined();
  });

  test("SC211: folders get today's project names, and a taken name, git URL or path is refused", async () => {
    storage = memoryStorage();
    expect(await storage.projects.findOrAddFolder("/w/My App")).toBe("my-app");
    expect((await storage.projects.find("my-app"))?.addedBy).toEqual({ channel: "server" });
    expect(await storage.projects.findOrAddFolder("/w/My App")).toBe("my-app");
    expect(await storage.projects.findOrAddFolder("/x/my-app")).toBe("my-app-2");
    await storage.projects.add("web", { ...PROJECT, path: "/abs/web", git: "git@x:web.git" });
    const add = (name: string, project: Partial<Project>) =>
      storage.projects.add(name, { ...PROJECT, path: "/abs/new", ...project });
    expect(await add("my-app", {})).toEqual({
      ok: false,
      error: "a project named my-app already exists",
    });
    expect(await add("new", { git: "git@x:web.git" })).toEqual({
      ok: false,
      error: "git@x:web.git is already a project",
    });
    expect(await add("new", { path: "/w/My App" })).toEqual({
      ok: false,
      error: "/w/My App is already project my-app",
    });
    expect(await storage.projects.remove("nope")).toBe(false);
  });

  test("SC212: a project a run row points at cannot be removed until the run is", async () => {
    storage = memoryStorage();
    await seedRun(storage);
    await expect(storage.projects.remove("repo")).rejects.toThrow();
    expect(await storage.projects.find("repo")).toEqual(PROJECT);
    await storage.runs.removeRun("r-1");
    expect(await storage.projects.remove("repo")).toBe(true);
  });

  test("SC213: a stored state's node-run artifacts, nested ones too, become one artifacts row each, once", async () => {
    const home = freshHome();
    storage = openStorage(home);
    await seedRun(storage);
    const nodeRun = (
      nodeRunId: string,
      artifacts: NodeRun["artifacts"],
      nodes?: NodeRun["nodes"],
    ): NodeRun => ({
      nodeRunId,
      nodeType: "agent",
      status: "completed",
      startedAt: AT,
      completedAt: AT,
      artifacts,
      ...(nodes === undefined ? {} : { nodes }),
    });
    const pr = nodeRun("pr", [
      { type: "pull-request", name: "pull-request", url: "https://pr.example/1" },
    ]);
    const make = nodeRun("make", [{ type: "plan", name: "plan", path: "artifacts/plan.md" }], {
      pr,
    });
    const withArtifacts = state("r-1", "feat-x", { lastEventSeq: 1, nodeRuns: { make } });
    await storage.runs.appendEvent("r-1", {
      event: event("r-1", 1),
      state: withArtifacts,
      expectedSeq: 0,
    });
    await storage.runs.appendEvent("r-1", {
      event: event("r-1", 2),
      state: { ...withArtifacts, lastEventSeq: 2 },
      expectedSeq: 1,
    });
    const db = new Database(join(home, "yok.db"), { readonly: true });
    try {
      const rows = db
        .query("SELECT node_run_id, type, name, path, url FROM artifacts ORDER BY node_run_id")
        .all();
      expect(rows).toEqual([
        { node_run_id: "make", type: "plan", name: "plan", path: "artifacts/plan.md", url: null },
        {
          node_run_id: "pr",
          type: "pull-request",
          name: "pull-request",
          path: null,
          url: "https://pr.example/1",
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("SC720: importRun refuses run name fix that project app already holds, storing neither r-9 nor its 2 events", async () => {
    storage = memoryStorage();
    await storage.projects.add("app", PROJECT);
    const fix = (id: string, events: readonly Event[]) =>
      storage.runs.importRun({
        run: draft(id, { project: "app", name: "fix" }),
        state: state(id, "fix", { lastEventSeq: events.length }),
        events,
      });
    expect(await fix("r-1", [event("r-1", 1)])).toEqual({ ok: true, value: undefined });

    expect(await fix("r-9", [event("r-9", 1), event("r-9", 2)])).toEqual({
      ok: false,
      error: "run name fix is taken in project app",
    });
    expect(await storage.runs.findRun("r-9")).toBeUndefined();
    expect(await storage.runs.readEvents("r-9")).toEqual([]);
    expect((await storage.runs.findRun("r-1"))?.name).toBe("fix");
    expect(await storage.runs.readEvents("r-1")).toEqual([event("r-1", 1)]);
    expect(await storage.runs.readState("r-1")).toEqual(state("r-1", "fix", { lastEventSeq: 1 }));
  });
});

const ANCHOR = { quote: "After saving a batch", before: "b", after: "a" };
const partComment = (text: string): CommentDraft => ({
  file: "artifacts/design.md",
  kind: "comment",
  text,
  anchor: { ...ANCHOR, lines: [14, 16], heading: "Approach" },
});
const wholeComment = (text: string): CommentDraft => ({
  file: "artifacts/review.md",
  kind: "global",
  text,
});

const seedCommented = async (): Promise<IStorage> => {
  const storage = memoryStorage();
  await seedRun(storage);
  await storage.comments.add("r-1", [partComment("one"), wholeComment("two")]);
  return storage;
};

describe("comments", () => {
  let storage: IStorage;
  afterEach(async () => {
    await storage.close();
  });

  test("SC301: a batch of a part-of-file and a whole-file comment reads back exactly as add returned it", async () => {
    storage = memoryStorage();
    await seedRun(storage);
    const added = await storage.comments.add("r-1", [partComment("one"), wholeComment("two")]);
    expect(added.map((c) => [c.id, c.status, c.thread.map((t) => [t.by, t.text])])).toEqual([
      ["c1", "sent", [["user", "one"]]],
      ["c2", "sent", [["user", "two"]]],
    ]);
    expect(await storage.comments.list("r-1")).toEqual(added);
    const [c1, c2] = added;
    expect(c1?.anchor).toEqual({ ...ANCHOR, lines: [14, 16], heading: "Approach" });
    expect(c2 !== undefined && "anchor" in c2).toBe(false);
    expect(c2 !== undefined && "deliveredAt" in c2).toBe(false);
  });

  test("SC302: a batch of 11 then 1 numbers r-1's comments c1 to c12 in number order, and r-2 starts again at c1", async () => {
    storage = memoryStorage();
    await seedRun(storage);
    await storage.runs.addRun(draft("r-2"));
    await storage.comments.add(
      "r-1",
      Array.from({ length: 11 }, (_, i) => wholeComment(`w${i}`)),
    );
    await storage.comments.add("r-1", [wholeComment("last")]);
    await storage.comments.add("r-2", [wholeComment("other")]);
    expect((await storage.comments.list("r-1")).map((c) => c.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `c${i + 1}`),
    );
    expect((await storage.comments.list("r-2")).map((c) => c.id)).toEqual(["c1"]);
  });

  test("SC303: four processes each adding ten batches of two and answering c1 ten times on one yok.db keep comments c1 to c81 and all 40 answers on c1", async () => {
    const home = freshHome();
    storage = openStorage(home);
    await seedRun(storage);
    await storage.comments.add("r-1", [wholeComment("first")]);
    const writer = (index: number) => `
      import { openStorage } from ${JSON.stringify(join(import.meta.dir, "storage.ts"))};
      const storage = openStorage(${JSON.stringify(home)});
      const draft = { file: "artifacts/review.md", kind: "global", text: "p${index}" };
      for (let i = 0; i < 10; i++) {
        await storage.comments.add("r-1", [draft, draft]);
        const answered = ${index % 2 === 0}
          ? await storage.comments.reply("r-1", "c1", { status: "answered", text: "p${index}" })
          : await storage.comments.addUserReply("r-1", "c1", "p${index}");
        if (!answered.ok) { console.error(answered.error); process.exit(1); }
      }
      await storage.close();
    `;
    const writers = [0, 1, 2, 3].map((index) =>
      Bun.spawn(["bun", "-e", writer(index)], { stdout: "pipe", stderr: "pipe" }),
    );
    const exits = await Promise.all(writers.map((writer) => writer.exited));
    const errors = await Promise.all(writers.map((writer) => new Response(writer.stderr).text()));

    expect({ exits, errors }).toEqual({ exits: [0, 0, 0, 0], errors: ["", "", "", ""] });
    const comments = await storage.comments.list("r-1");
    expect(new Set(comments.map((c) => c.id))).toEqual(
      new Set(Array.from({ length: 81 }, (_, i) => `c${i + 1}`)),
    );
    expect(comments.find((c) => c.id === "c1")?.thread).toHaveLength(41);
  }, 30_000);

  test("SC304: a delete with no words, a delete with words and a replace open their threads with what the person asked", async () => {
    storage = memoryStorage();
    await seedRun(storage);
    const place = { ...ANCHOR, lines: [3, 3] as [number, number] };
    const added = await storage.comments.add("r-1", [
      { file: "artifacts/a.md", kind: "delete", text: "", anchor: place },
      { file: "artifacts/a.md", kind: "delete", text: "It is stale.", anchor: place },
      { file: "artifacts/a.md", kind: "replace", text: "twice", anchor: place },
    ]);
    expect(added.map((c) => c.thread[0]?.text)).toEqual([
      "Delete this.",
      "Delete this. It is stale.",
      "Replace with “twice”",
    ]);
  });

  test("SC305: an agent reply makes c1 changed and a user follow-up keeps c2 sent, each growing its thread", async () => {
    storage = await seedCommented();
    const replied = await storage.comments.reply("r-1", "c1", { status: "changed", text: "fixed" });
    const followed = await storage.comments.addUserReply("r-1", "c2", "and also");
    expect(replied.ok && [replied.value.status, replied.value.thread.at(-1)]).toEqual([
      "changed",
      expect.objectContaining({ by: "agent", text: "fixed" }),
    ]);
    expect(followed.ok && followed.value.status).toBe("sent");
    const [c1, c2] = await storage.comments.list("r-1");
    expect([c1?.status, c1?.thread.at(-1)?.by, c1?.thread.at(-1)?.text]).toEqual([
      "changed",
      "agent",
      "fixed",
    ]);
    expect([c2?.status, c2?.thread.map((t) => t.by)]).toEqual(["sent", ["user", "user"]]);
  });

  test("SC306: a reply or follow-up on unknown c9 fails with no comment c9 and changes nothing", async () => {
    storage = await seedCommented();
    const before = await storage.comments.list("r-1");
    const results = [
      await storage.comments.reply("r-1", "c9", { status: "answered", text: "x" }),
      await storage.comments.addUserReply("r-1", "c9", "x"),
    ];
    expect(results).toEqual([
      { ok: false, error: "no comment c9" },
      { ok: false, error: "no comment c9" },
    ]);
    expect(await storage.comments.list("r-1")).toEqual(before);
  });

  test("SC307: an agent reply of blank text is refused and c1 stays sent with one entry", async () => {
    storage = await seedCommented();
    const replied = await storage.comments.reply("r-1", "c1", { status: "answered", text: "  " });
    expect(replied).toEqual({ ok: false, error: "the reply has no text" });
    const [c1] = await storage.comments.list("r-1");
    expect([c1?.status, c1?.thread.length]).toEqual(["sent", 1]);
  });

  test("SC308: marking delivered stamps sent c1 and returns only it, leaving answered c2 without deliveredAt", async () => {
    storage = await seedCommented();
    await storage.comments.reply("r-1", "c2", { status: "answered", text: "ok" });
    const marked = await storage.comments.markDelivered("r-1", await storage.comments.list("r-1"));
    expect(marked.map((c) => c.id)).toEqual(["c1"]);
    const [c1, c2] = await storage.comments.list("r-1");
    expect([c1?.status, typeof c1?.deliveredAt]).toEqual(["delivered", "string"]);
    expect([c2?.status, c2?.deliveredAt]).toEqual(["answered", undefined]);
  });

  test("SC309: a follow-up posted after the batch was read keeps c2 sent when the typed batch is marked delivered", async () => {
    storage = await seedCommented();
    const typed = await storage.comments.list("r-1");
    await storage.comments.addUserReply("r-1", "c2", "one more thing");
    await storage.comments.markDelivered("r-1", typed);
    expect((await storage.comments.list("r-1")).map((c) => c.status)).toEqual([
      "delivered",
      "sent",
    ]);
  });

  test("SC310: removing run r-1 takes its comments", async () => {
    storage = await seedCommented();
    await storage.runs.removeRun("r-1");
    expect(await storage.comments.list("r-1")).toEqual([]);
  });
});
