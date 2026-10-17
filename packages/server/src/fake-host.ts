import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProvider } from "@yok/core";
import type { IAgentProvider, ITerminal, ITerminalHost, NodeRun, State } from "@yok/sdk";
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

// The real Claude provider over a fake pane, so delivery runs the same screen checks as in a run.
export const claudeOver = (host: ITerminalHost): IAgentProvider =>
  claudeProvider({
    host,
    configPath: join(mkdtempSync(join(tmpdir(), "yok-claude-config-")), ".claude.json"),
    binary: "claude",
    log: noopLogger,
  });

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

export type SseEvent = { event: string; data: unknown };

export const sseReader = (res: Response) => {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const seen: SseEvent[] = [];
  let buffer = "";
  const parse = (chunk: string): void => {
    const event = /^event: (.*)$/m.exec(chunk)?.[1];
    const data = /^data: (.*)$/m.exec(chunk)?.[1];
    if (event !== undefined && data !== undefined) seen.push({ event, data: JSON.parse(data) });
  };
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      chunks.forEach(parse);
    }
  })().catch(() => undefined);
  const waitFor = async (match: (e: SseEvent) => boolean, ms = 3000): Promise<SseEvent> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = seen.find(match);
      if (hit !== undefined) return hit;
      await Bun.sleep(25);
    }
    throw new Error(`no matching event in ${ms}ms; saw ${JSON.stringify(seen)}`);
  };
  return { seen, waitFor, close: () => reader.cancel().then(() => pump) };
};
