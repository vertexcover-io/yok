import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentType,
  type IAgentProvider,
  type ITerminal,
  noopLogger,
  type ResetWait,
  type RunRef,
  runDirOf,
} from "@yok/sdk";
import { appendRunEvent, jsonlEventStore } from "@yok/sdk/internal";
import { runAutoResume } from "./auto-resume.ts";

const setUp = () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "auto-resume-")));
  const run: RunRef = { id: "r-1", cwd, name: "feat-x" };
  const runDir = runDirOf(cwd, "feat-x");
  mkdirSync(runDir, { recursive: true });
  return { run, runDir };
};

type Stop = Readonly<{ sessionId?: string; agent?: AgentType }>;

const stopReached = async (
  run: RunRef,
  type: string,
  payload: Readonly<Record<string, string | boolean>>,
): Promise<string> => {
  const stored = await appendRunEvent(run, { type, source: "hooks", payload });
  if (!stored.ok) throw new Error(stored.error);
  return stored.value.event.id;
};

const limitReached = (
  run: RunRef,
  message: string,
  { sessionId = "s1", agent = "claude" }: Stop = {},
) => stopReached(run, "agent.limit.reached", { agent, sessionId, error: "rate_limit", message });

const errorReached = (
  run: RunRef,
  { sessionId = "s1", agent = "claude", progressed = false }: Stop & { progressed?: boolean } = {},
) =>
  stopReached(run, "agent.error.reached", {
    agent,
    sessionId,
    error: "server_error",
    message: "API Error: Connection lost mid-response",
    progressed,
  });

// What agent.stopped carries for an API error: the error, without the progress the hook read.
const ERROR_STOPPED = {
  agent: "claude",
  sessionId: "s1",
  error: "server_error",
  message: "API Error: Connection lost mid-response",
};

const turnEnded = (run: RunRef) =>
  appendRunEvent(run, {
    type: "hooks.stop.called",
    source: "hooks",
    payload: {
      agent: "claude",
      sessionId: "s1",
      touchedRun: null,
      decision: "allow",
      reason: "run-finished",
      blockStreak: 0,
    },
  });

const errorResumed = (run: RunRef, errorEventId: string) =>
  stopReached(run, "agent.error.resumed", { sessionId: "s1", errorEventId });

const unused = () => Promise.reject(new Error("unused"));

// The wait only hands this to the agent, so its methods are never called.
const TERMINAL: ITerminal = {
  sendText: unused,
  sendKeys: unused,
  capture: unused,
  isAlive: unused,
  kill: unused,
  rename: unused,
  respawn: unused,
  attachCommand: () => [],
};

type Seen = { waits: { terminal: ITerminal; message: string }[]; prompts: string[] };

// An agent whose reset reading and prompt answer are given, recording what it was asked.
const fakeAgent = (
  reset: ResetWait | null,
  answer: "sent" | "not-ready" | "failed" = "sent",
): { agent: IAgentProvider; seen: Seen } => {
  const seen: Seen = { waits: [], prompts: [] };
  const agent: IAgentProvider = {
    type: "claude",
    skillPrefix: "/",
    checks: [],
    launch: unused,
    relaunch: unused,
    prompt: unused,
    stop: unused,
    run: unused,
    limitResetWait: async (terminal, message) => {
      seen.waits.push({ terminal, message });
      return reset;
    },
    promptWhenReady: async (_terminal, text) => {
      seen.prompts.push(text);
      return answer === "failed"
        ? { ok: false, error: "tmux capture failed" }
        : { ok: true, value: answer };
    },
  };
  return { agent, seen };
};

let onSleep: () => Promise<void> = async () => {};

beforeEach(() => {
  let now = Date.parse("2026-10-01T13:00:00Z");
  setSystemTime(new Date(now));
  onSleep = async () => {};
  spyOn(Bun, "sleep").mockImplementation(async (ms) => {
    now += Number(ms);
    setSystemTime(new Date(now));
    await onSleep();
  });
});

afterEach(() => {
  setSystemTime();
  mock.restore();
});

const eventsOf = async (runDir: string) => jsonlEventStore(runDir).read();
const payloadOf = async (runDir: string, type: string) =>
  (await eventsOf(runDir)).find((event) => event.type === type)?.payload;
const payloadsOf = async (runDir: string, type: string) =>
  (await eventsOf(runDir)).filter((event) => event.type === type).map((event) => event.payload);
const payloadsById = async (runDir: string, ids: readonly string[]) =>
  (await eventsOf(runDir)).filter((event) => ids.includes(event.id)).map((event) => event.payload);

const HOUR = 3_600_000;

const waitWith = (run: RunRef, eventId: string, agent: IAgentProvider) =>
  runAutoResume({
    run,
    sessionId: "s1",
    eventId,
    agents: { claude: agent },
    terminal: TERMINAL,
    log: noopLogger,
  });

describe("runAutoResume", () => {
  test.each<[string, ResetWait | null, string]>([
    ["message", { ms: 2 * HOUR, from: "message" }, "2026-10-01T15:00:00.000Z"],
    ["screen", { ms: 3 * HOUR, from: "screen" }, "2026-10-01T16:00:00.000Z"],
    ["fallback", null, "2026-10-01T13:15:00.000Z"],
  ])(
    "SC11: a reset read from the %s sets resumeAt, and the agent is prompted to continue once it passes",
    async (from, reset, resumeAt) => {
      const { run, runDir } = setUp();
      const limitEventId = await limitReached(run, "You've hit your limit");
      const { agent, seen } = fakeAgent(reset);

      await waitWith(run, limitEventId, agent);

      expect(seen.waits).toEqual([{ terminal: TERMINAL, message: "You've hit your limit" }]);
      expect(await payloadOf(runDir, "agent.limit.waiting")).toEqual({
        sessionId: "s1",
        limitEventId,
        resumeAt,
        from,
      });
      expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(resumeAt));
      expect(seen.prompts).toEqual(["continue"]);
      expect(await payloadOf(runDir, "agent.limit.resumed")).toEqual({
        sessionId: "s1",
        limitEventId,
      });
    },
  );

  test.each([
    ["not ready for input", "not-ready"],
    ["unreachable when continue is typed", "failed"],
  ] as const)(
    "an agent %s gets no resumed event, and agent.stopped is recorded so a person is pinged",
    async (_, answer) => {
      const { run, runDir } = setUp();
      const errorEventId = await errorReached(run);
      const { agent, seen } = fakeAgent(null, answer);
      await waitWith(run, errorEventId, agent);
      expect(seen.prompts).toEqual(["continue"]);
      expect(await payloadOf(runDir, "agent.error.resumed")).toBeUndefined();
      expect(await payloadsOf(runDir, "agent.stopped")).toEqual([ERROR_STOPPED]);
    },
  );

  test("a newer limit for the session ends the wait within a minute, prompting nothing", async () => {
    const { run, runDir } = setUp();
    const limitEventId = await limitReached(run, "limit");
    onSleep = async () => void (await limitReached(run, "limit"));
    const { agent, seen } = fakeAgent({ ms: 2 * HOUR, from: "message" });
    await waitWith(run, limitEventId, agent);
    expect(seen.prompts).toEqual([]);
    expect(Date.now()).toBeLessThanOrEqual(Date.parse("2026-10-01T13:01:00Z"));
    expect(await payloadOf(runDir, "agent.limit.resumed")).toBeUndefined();
  });

  test.each([
    [
      "any later hook call from the session, such as a tool call after a manual resume",
      {
        type: "hooks.pre-tool-use.called",
        payload: {
          agent: "claude",
          sessionId: "s1",
          tool: "Bash",
          handler: "h",
          decision: "allow",
        },
      },
    ],
    [
      "a new session starting, such as after /clear in the same terminal",
      {
        type: "hooks.session-start.called",
        payload: { agent: "claude", sessionId: "s2", source: "clear" },
      },
    ],
  ] as const)("%s ends the wait, prompting nothing", async (_, event) => {
    const { run } = setUp();
    const limitEventId = await limitReached(run, "limit");
    onSleep = async () => void (await appendRunEvent(run, { ...event, source: "hooks" }));
    const { agent, seen } = fakeAgent({ ms: 2 * HOUR, from: "message" });
    await waitWith(run, limitEventId, agent);
    expect(seen.prompts).toEqual([]);
  });

  test("a limit in another session leaves this session's wait to prompt continue", async () => {
    const { run } = setUp();
    const limitEventId = await limitReached(run, "limit");
    onSleep = async () => void (await limitReached(run, "limit", { sessionId: "s2" }));
    const { agent, seen } = fakeAgent({ ms: 2 * HOUR, from: "message" });
    await waitWith(run, limitEventId, agent);
    expect(seen.prompts).toEqual(["continue"]);
  });

  test("SC9: the 21st usage limit in a row records agent.stopped instead of waiting", async () => {
    const { run, runDir } = setUp();
    for (const _ of Array.from({ length: 20 })) await limitReached(run, "credits");
    const limitEventId = await limitReached(run, "credits");
    const { agent, seen } = fakeAgent(null);
    await waitWith(run, limitEventId, agent);
    expect(seen.prompts).toEqual([]);
    expect(await payloadOf(runDir, "agent.limit.waiting")).toBeUndefined();
    expect(await payloadsOf(runDir, "agent.stopped")).toEqual(
      await payloadsById(runDir, [limitEventId]),
    );
  });

  test("SC10: an agent with no provider, or no terminal to reach, gets no wait and records agent.stopped", async () => {
    const { run, runDir } = setUp();
    const { agent, seen } = fakeAgent({ ms: HOUR, from: "message" });
    const codexLimit = await limitReached(run, "limit", { agent: "codex" });
    await waitWith(run, codexLimit, agent);
    const claudeLimit = await limitReached(run, "limit");
    await runAutoResume({
      run,
      sessionId: "s1",
      eventId: claudeLimit,
      agents: { claude: agent },
      terminal: undefined,
      log: noopLogger,
    });
    expect(seen.waits).toEqual([]);
    expect(seen.prompts).toEqual([]);
    expect(await payloadOf(runDir, "agent.limit.waiting")).toBeUndefined();
    expect(await payloadsOf(runDir, "agent.stopped")).toEqual(
      await payloadsById(runDir, [codexLimit, claudeLimit]),
    );
  });

  test.each([
    [1, "2026-10-01T13:00:30.000Z"],
    [2, "2026-10-01T13:01:00.000Z"],
    [3, "2026-10-01T13:02:00.000Z"],
    [4, "2026-10-01T13:04:00.000Z"],
  ])(
    "SC4: API error %p in a row waits until %s, then types continue once",
    async (inARow, resumeAt) => {
      const { run, runDir } = setUp();
      for (const _ of Array.from({ length: inARow - 1 })) await errorReached(run);
      const errorEventId = await errorReached(run);
      const { agent, seen } = fakeAgent({ ms: HOUR, from: "message" });

      await waitWith(run, errorEventId, agent);

      expect(await payloadOf(runDir, "agent.error.waiting")).toEqual({
        sessionId: "s1",
        errorEventId,
        error: "server_error",
        resumeAt,
      });
      expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(resumeAt));
      expect(seen.prompts).toEqual(["continue"]);
      expect(seen.waits).toEqual([]);
      expect(await payloadOf(runDir, "agent.error.resumed")).toEqual({
        sessionId: "s1",
        errorEventId,
      });
    },
  );

  test("SC5: the 5th API error in a row types nothing and records agent.stopped", async () => {
    const { run, runDir } = setUp();
    for (const _ of Array.from({ length: 4 })) await errorReached(run);
    const errorEventId = await errorReached(run);
    const { agent, seen } = fakeAgent(null);
    await waitWith(run, errorEventId, agent);
    expect(seen.prompts).toEqual([]);
    expect(await payloadOf(runDir, "agent.error.waiting")).toBeUndefined();
    expect(await payloadsOf(runDir, "agent.stopped")).toEqual([ERROR_STOPPED]);
  });

  test("SC6: a usage limit between two API errors neither resets nor adds to the count, so the 2nd waits 1m", async () => {
    const { run, runDir } = setUp();
    await errorReached(run);
    await limitReached(run, "limit");
    const errorEventId = await errorReached(run);
    const { agent } = fakeAgent(null);
    await waitWith(run, errorEventId, agent);
    expect(await payloadOf(runDir, "agent.error.waiting")).toMatchObject({
      resumeAt: "2026-10-01T13:01:00.000Z",
    });
  });

  test.each([
    [false, "adds to the count, so the 5th stops"],
    [true, "starts the count again, so it waits 30s and continues"],
  ])(
    "SC7: an API error whose transcript shows progress since continue (%p) %s",
    async (progressed, _) => {
      const { run, runDir } = setUp();
      for (const _ of Array.from({ length: 4 })) await errorResumed(run, await errorReached(run));
      const errorEventId = await errorReached(run, { progressed });
      const { agent, seen } = fakeAgent(null);
      await waitWith(run, errorEventId, agent);
      expect(seen.prompts).toEqual(progressed ? ["continue"] : []);
      expect(await payloadOf(runDir, "agent.error.waiting")).toEqual(
        progressed ? expect.objectContaining({ resumeAt: "2026-10-01T13:00:30.000Z" }) : undefined,
      );
      expect(await payloadsOf(runDir, "agent.stopped")).toEqual(progressed ? [] : [ERROR_STOPPED]);
    },
  );

  test("SC7: the turn ending between API errors starts the count again, so the next waits 30s and continues", async () => {
    const { run, runDir } = setUp();
    for (const _ of Array.from({ length: 4 })) await errorReached(run);
    await turnEnded(run);
    const errorEventId = await errorReached(run);
    const { agent, seen } = fakeAgent(null);
    await waitWith(run, errorEventId, agent);
    expect(await payloadOf(runDir, "agent.error.waiting")).toMatchObject({
      resumeAt: "2026-10-01T13:00:30.000Z",
    });
    expect(seen.prompts).toEqual(["continue"]);
    expect(await payloadOf(runDir, "agent.stopped")).toBeUndefined();
  });

  test("SC8: a newer API error during the wait ends it within a minute, typing nothing", async () => {
    const { run, runDir } = setUp();
    for (const _ of Array.from({ length: 3 })) await errorReached(run);
    const errorEventId = await errorReached(run);
    onSleep = async () => void (await errorReached(run));
    const { agent, seen } = fakeAgent(null);
    await waitWith(run, errorEventId, agent);
    expect(seen.prompts).toEqual([]);
    expect(Date.now()).toBeLessThanOrEqual(Date.parse("2026-10-01T13:01:00Z"));
    expect(await payloadOf(runDir, "agent.error.resumed")).toBeUndefined();
    expect(await payloadOf(runDir, "agent.stopped")).toBeUndefined();
  });

  test("a person typing continue during the wait, so the agent resumes its work, ends the wait with no prompt and no agent.stopped", async () => {
    const { run, runDir } = setUp();
    const errorEventId = await errorReached(run);
    const resumed = { agent: "claude", sessionId: "s1", reason: "api-error", tool: "Bash" };
    onSleep = async () =>
      void (await appendRunEvent(run, {
        type: "agent.resumed",
        source: "hooks",
        payload: resumed,
      }));
    const { agent, seen } = fakeAgent(null, "not-ready");
    await waitWith(run, errorEventId, agent);
    expect(seen.prompts).toEqual([]);
    expect(await payloadOf(runDir, "agent.stopped")).toBeUndefined();
  });
});
