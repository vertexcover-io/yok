import { claudeProvider } from "@yok/core";
import type {
  IAgentProvider,
  ITerminal,
  ITerminalHost,
  LaunchOptions,
  NodeRun,
  Result,
  State,
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
    kill: async () => ({ ok: true, value: undefined }),
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
  isBusy: () => Promise.resolve({ ok: true, value: false }),
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
