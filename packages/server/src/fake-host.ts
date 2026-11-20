import { claudeProvider } from "@yok/core";
import type {
  IAgentProvider,
  IStorage,
  ITerminal,
  ITerminalHost,
  LaunchOptions,
  NodeRun,
  Result,
  State,
  WorkflowRun,
} from "@yok/sdk";
import { noopLogger } from "@yok/sdk";

export const RULE = "─".repeat(40);
export const EMPTY_BOX = `${RULE}\n❯\n${RULE}\n  Model: Opus`;

export const fakeHost = (screen: string | (() => string), alive = true) => {
  const calls: string[] = [];
  const pane: ITerminal = {
    sendText: async (text) => {
      calls.push(`text:${text}`);
      return { ok: true, value: undefined };
    },
    sendKeys: async (keys) => {
      calls.push(`keys:${keys.join("+")}`);
      return { ok: true, value: undefined };
    },
    capture: async () => ({ ok: true, value: typeof screen === "string" ? screen : screen() }),
    isAlive: async () => alive,
    kill: async () => {
      calls.push("kill");
      return { ok: true, value: undefined };
    },
    rename: async () => ({ ok: true, value: undefined }),
    respawn: async () => ({ ok: true, value: undefined }),
    attachCommand: () => ["true"],
  };
  const host: ITerminalHost = {
    checks: [],
    create: async () => ({ ok: true, value: pane }),
    find: () => pane,
    list: async () => [],
  };
  return { host, calls };
};

const done = () => Promise.resolve({ ok: true as const, value: undefined });

export const fakePane = (name: string): ITerminal => ({
  sendText: done,
  sendKeys: done,
  capture: () => Promise.resolve({ ok: true, value: "" }),
  isAlive: () => Promise.resolve(true),
  rename: done,
  respawn: done,
  kill: done,
  attachCommand: () => ["tmux", "attach-session", "-t", name],
});

export const fakeProvider = (
  type: IAgentProvider["type"],
  launch: (
    options: LaunchOptions,
  ) => Promise<Result<{ terminalName: string; terminal: ITerminal }>>,
): IAgentProvider => ({
  type,
  skillPrefix: type === "codex" ? "$" : "/",
  checks: [],
  launch,
  relaunch: () => Promise.resolve({ ok: true, value: undefined }),
  prompt: () => Promise.resolve({ ok: true, value: undefined }),
  stop: () => Promise.resolve({ ok: true, value: undefined }),
  run: () => Promise.resolve({ ok: false, error: new Error("not implemented") }),
  limitResetWait: () => Promise.resolve(null),
  promptWhenReady: () => Promise.resolve({ ok: true, value: "not-ready" }),
});

// The real Claude provider over a fake pane, so delivery runs the same screen checks as in a run.
export const claudeOver = (host: ITerminalHost): IAgentProvider =>
  claudeProvider({ host, binary: "claude", log: noopLogger });

// A minimal state that parses, holding the given node runs.
export const seedState = (runDir: string, nodeRuns: Readonly<Record<string, NodeRun>>): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "demo",
  runDir,
  version: "1",
  workflow: { name: "w", path: "artifacts/w.yaml" },
  input: {},
  scope: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: runDir,
    repositories: { r: { path: runDir, git: { branch: "b", baseBranch: "main", startSha: "s" } } },
  },
  nodeRuns: { ...nodeRuns },
  activeSessions: [],
  tiers: null,
  eventHandlers: {},
  subscribers: {},
});

type SeededUser = Readonly<{
  name: string;
  email?: string;
  github: Readonly<{ id: number; login: string; token?: string }>;
  slack?: string;
}>;

// A yok user as a GitHub sign-in leaves one; with no token given, the sign-in's token is dropped.
export const seedUser = async (storage: IStorage, user: SeededUser): Promise<string> => {
  const { id, login, token } = user.github;
  const signIn = { id, login, name: user.name, email: user.email ?? "", token: token ?? "gho_x" };
  const [userId] = await storage.users.saveGitHubUser(signIn);
  if (token === undefined) {
    const github = { provider: "github", providerId: String(id), username: login };
    await storage.users.addUserAccount(userId, github);
  }
  if (user.slack !== undefined) {
    await storage.users.addUserAccount(userId, { provider: "slack", providerId: user.slack });
  }
  return userId;
};

// Stores RUN, first adding its project at the run's folder when there is no such project. A
// named run given STATE is stored unnamed and named by init with it, as orchestrate init does.
export const seedRun = async (
  storage: IStorage,
  run: WorkflowRun,
  state?: State,
): Promise<void> => {
  if ((await storage.projects.find(run.project)) === undefined) {
    const project = { path: run.cwd, addedBy: { channel: "api" }, addedAt: run.createdAt };
    const added = await storage.projects.add(run.project, project);
    if (!added.ok) throw new Error(added.error);
  }
  const { cwd: _cwd, ...draft } = run;
  if (state === undefined || run.name === null) return storage.runs.addRun(draft);
  await storage.runs.addRun({ ...draft, name: null });
  const named = await storage.runs.initRun(run.id, run.name, state);
  if (!named.ok) throw new Error(named.error);
};
