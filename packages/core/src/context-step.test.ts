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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { dirname, join } from "node:path";
import {
  type IAgentProvider,
  type ITerminal,
  type LaunchOptions,
  type NodeRun,
  noopLogger,
  type RunRef,
  runDirOf,
  type State,
} from "@yok/sdk";
import { appendRunEvent, createRegistry, jsonlEventStore } from "@yok/sdk/internal";
import {
  clearDeadSwitchLocks,
  completeContextOnSessionStart,
  findOpenContextRun,
  runContextStep,
  runModelStep,
} from "./context-step.ts";

const RESUME = "/yok:orchestrate --resume feat-x";
// Claude's input box: a ❯ line between two rules. Claude keeps it on screen while it works.
const RULE = "─".repeat(40);
const IDLE = `${RULE}\n❯ \n${RULE}`;
const BUSY = `· Vibing… (3s)\n${IDLE}`;
const REFUSED = `⎿  Not enough messages to compact.\n${IDLE}`;

const seed = (runDir: string): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "feat-x",
  runDir,
  config: { path: null, root: runDir },
  version: "2.0.0",
  workflow: { name: "t", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: "/repo",
    repositories: {
      app: { path: "/repo", git: { branch: "b", baseBranch: "main", startSha: "a" } },
    },
  },
  nodeRuns: {
    step: {
      nodeRunId: "nr-1",
      nodeType: "context",
      status: "running",
      startedAt: "2026-09-26T10:00:00Z",
      completedAt: null,
      artifacts: [],
      input: null,
    },
  },
  activeSessions: [{ agent: "claude", sessionId: "A" }],
  tiers: null,
  eventHandlers: {},
  subscribers: {},
});

// A run whose one open step is a context node with the given fields.
const setUp = async (node: string, header = "") => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "context-step-")));
  const run: RunRef = { id: "r-1", cwd, name: "feat-x" };
  const runDir = runDirOf(cwd, "feat-x");
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(
    join(runDir, "workflow.yaml"),
    `name: t\n${header}nodes:\n  - { id: step, ${node} }\n`,
  );
  writeFileSync(join(runDir, "state.json"), JSON.stringify(seed(runDir)));
  const registry = createRegistry(join(cwd, "registry.json"));
  await registry.addRun({
    id: "r-1",
    workflow: "t",
    workflowPath: join(runDir, "workflow.yaml"),
    inputs: {},
    cwd,
    sessions: [{ agent: "claude", sessionId: "A" }],
    name: "feat-x",
    terminal: "claude-feat-x-r-1",
    config: null,
    tiers: null,
    createdAt: new Date().toISOString(),
  });
  return { run, runDir, registry };
};

type Typed = string | readonly string[];

// A terminal whose screen comes from `screen(captures, typed)`; `onSubmit` runs when Enter follows
// text.
const fakeTerminal = (
  screen: (captures: number, typed: readonly Typed[]) => string,
  onSubmit: (text: string) => Promise<void> = async () => {},
) => {
  const typed: Typed[] = [];
  let captures = 0;
  const done = async () => ({ ok: true as const, value: undefined });
  const terminal: ITerminal = {
    sendText: async (text) => {
      typed.push(text);
      return done();
    },
    sendKeys: async (keys) => {
      typed.push(keys);
      const text = typed.at(-2);
      if (keys[0] === "Enter" && typeof text === "string") await onSubmit(text);
      return done();
    },
    capture: async () => ({ ok: true, value: screen(captures++, typed) }),
    isAlive: async () => true,
    kill: done,
    rename: done,
    respawn: done,
    attachCommand: () => [],
  };
  return { terminal, typed, captureCount: () => captures };
};

type Relaunch = Readonly<{ terminal: ITerminal; sessionId: string; options: LaunchOptions }>;

const fakeProvider = (relaunchOk = true) => {
  const relaunches: Relaunch[] = [];
  const provider: IAgentProvider = {
    type: "claude",
    skillPrefix: "/",
    checks: [],
    launch: async () => ({
      ok: true,
      value: { terminalName: "unused", terminal: fakeTerminal(() => IDLE).terminal },
    }),
    relaunch: async (terminal, sessionId, options) => {
      relaunches.push({ terminal, sessionId, options });
      return relaunchOk ? { ok: true, value: undefined } : { ok: false, error: "no pane" };
    },
    prompt: async () => ({ ok: true, value: undefined }),
    stop: async () => ({ ok: true, value: undefined }),
    run: async () => ({ ok: false, error: new Error("unused") }),
    limitResetWait: async () => null,
    promptWhenReady: async () => ({ ok: true, value: "not-ready" }),
  };
  return { provider, relaunches };
};

// Waits in the helper run on Bun.sleep and Date.now; faking both lets a 180-second timeout pass
// at once.
beforeEach(() => {
  let now = Date.parse("2026-10-01T00:00:00Z");
  setSystemTime(new Date(now));
  spyOn(Bun, "sleep").mockImplementation(async (ms) => {
    now += Number(ms);
    setSystemTime(new Date(now));
  });
});

afterEach(() => {
  setSystemTime();
  mock.restore();
});

const LAUNCH = { cwd: "/repo", orchestrateArgv: ["/o.ts"], pluginDir: "/plugin-repo" };
const HOME = mkdtempSync(join(tmpdir(), "yok-home-"));

type Context = Awaited<ReturnType<typeof setUp>>;

const helper = async (
  context: Context,
  terminal: ITerminal | undefined,
  provider: IAgentProvider = fakeProvider().provider,
) =>
  runContextStep({
    run: context.run,
    nodeRunId: "nr-1",
    oldSessionId: "A",
    terminal,
    registry: context.registry,
    provider,
    launch: LAUNCH,
    home: HOME,
    log: noopLogger,
  });

const eventsOf = (runDir: string) => jsonlEventStore(runDir).read();
const typesOf = (log: readonly Typed[]) =>
  log.map((entry) => (typeof entry === "string" ? entry : entry[0]));
const typesIn = async (runDir: string) => (await eventsOf(runDir)).map((event) => event.type);
const stateOf = (runDir: string): State =>
  JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
const stepOutput = async (runDir: string) =>
  (await eventsOf(runDir)).find((event) => event.type === "workflow.node.completed")?.payload;

// A provider whose relaunch plays the fresh Claude: its SessionStart hook fires with the new id.
const startingProvider = (context: Context) => {
  const fake = fakeProvider();
  const provider: IAgentProvider = {
    ...fake.provider,
    relaunch: async (terminal, sessionId, options) => {
      const relaunched = await fake.provider.relaunch(terminal, sessionId, options);
      await completeContextOnSessionStart(context.run, sessionId, "startup");
      return relaunched;
    },
  };
  return { provider, relaunches: fake.relaunches };
};

// What the --resume skill records first, once Claude takes the resume line.
const resumed = (run: RunRef) =>
  appendRunEvent(run, {
    type: "orchestrate.resume",
    source: "orchestrate",
    payload: { input: {}, output: { interrupted: [] } },
  });

const typedLine = (line: string) => ["C-u", line, "Enter"];

// What Claude 2.1.309 shows under its /config popup, with the search box focused and after
// leaving it; the popup hides the input box.
const CONFIG_SEARCH_FOOTER = "Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear";
const CONFIG_LIST_FOOTER = "Enter/Space to change · / to search · Esc to close";
const isEscape = (entry: Typed) => typeof entry !== "string" && entry[0] === "Escape";
const escapesIn = (typed: readonly Typed[]) => typed.filter(isEscape).length;

// An idle Claude that runs the --resume skill when the resume line is typed.
const resumingTerminal = (run: RunRef) =>
  fakeTerminal(
    () => IDLE,
    async (text) => {
      if (text === RESUME) await resumed(run);
    },
  );

describe("runContextStep: new", () => {
  test("records the start, relaunches Claude on a new session, and the new session's SessionStart completes the node", async () => {
    const context = await setUp("type: context, action: new");
    let capturesAtRelaunch = -1;
    let typesAtRelaunch: string[] = [];
    const fake = fakeTerminal((captures) => (captures < 2 ? BUSY : IDLE));
    const starting = startingProvider(context);
    const watched: IAgentProvider = {
      ...starting.provider,
      relaunch: async (terminal, sessionId, options) => {
        capturesAtRelaunch = fake.captureCount();
        typesAtRelaunch = await typesIn(context.runDir);
        return starting.provider.relaunch(terminal, sessionId, options);
      },
    };

    await helper(context, fake.terminal, watched);

    expect(capturesAtRelaunch).toBe(3);
    expect(typesAtRelaunch).toEqual(["workflow.session.replaced", "workflow.context.started"]);
    const [relaunch] = starting.relaunches;
    expect(relaunch?.terminal).toBe(fake.terminal);
    expect(relaunch).toMatchObject({ options: { ...LAUNCH, prompt: RESUME } });
    const sessionId = relaunch?.sessionId ?? "";
    expect(fake.typed).toEqual([]);
    expect((await context.registry.findRun("r-1"))?.sessions).toContainEqual({
      agent: "claude",
      sessionId,
    });
    expect(await typesIn(context.runDir)).toEqual([
      "workflow.session.replaced",
      "workflow.context.started",
      "workflow.node.completed",
    ]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "new", applied: true, sessionId },
    });
  });

  test("a relaunch that fails undoes the swap, completes unapplied and resumes the old session", async () => {
    const context = await setUp("type: context, action: new");
    const fake = resumingTerminal(context.run);

    await helper(context, fake.terminal, fakeProvider(false).provider);

    const replaced = (await eventsOf(context.runDir))
      .filter((event) => event.type === "workflow.session.replaced")
      .map((event) => event.payload as { previousSessionId: string; sessionId: string });
    const newId = replaced[0]?.sessionId ?? "";
    expect(replaced.map((event) => event.previousSessionId)).toEqual(["A", newId]);
    expect(replaced[1]?.sessionId).toBe("A");
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "new", applied: false, reason: "no pane" },
    });
    expect(typesOf(fake.typed)).toEqual(typedLine(RESUME));
  });

  test("the new session launches with the run's .env and workflow env, under yok's own", async () => {
    const context = await setUp("type: context, action: new", "env: { FROM_WORKFLOW: '1' }\n");
    writeFileSync(join(context.run.cwd, ".env"), "FROM_DOTENV=1\nYOK_RUN_ID=spoofed\n");
    const starting = startingProvider(context);

    await helper(context, fakeTerminal(() => IDLE).terminal, starting.provider);

    expect(starting.relaunches[0]?.options.env).toEqual({
      FROM_DOTENV: "1",
      FROM_WORKFLOW: "1",
      PATH: expect.stringContaining(join(HOME, "shims")),
      YOK_RUN_ID: "r-1",
      YOK_HOME: HOME,
    });
  });

  test("a run env that fails to load completes unapplied and resumes the old session, launching nothing", async () => {
    const context = await setUp("type: context, action: new", "envFile: gone.env\n");
    const fake = resumingTerminal(context.run);
    const { provider, relaunches } = fakeProvider();

    await helper(context, fake.terminal, provider);

    expect(relaunches).toEqual([]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "new", applied: false },
    });
    expect(JSON.stringify(await stepOutput(context.runDir))).toContain("gone.env");
    expect(typesOf(fake.typed)).toEqual(typedLine(RESUME));
    expect((await context.registry.findRun("r-1"))?.sessions).toEqual([
      { agent: "claude", sessionId: "A" },
    ]);
    expect(await typesIn(context.runDir)).not.toContain("workflow.context.started");
  });

  test("a new session that never starts completes the node unapplied after the timeout", async () => {
    const context = await setUp("type: context, action: new");

    await helper(context, fakeTerminal(() => IDLE).terminal);

    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "new", applied: false, reason: expect.stringContaining("SessionStart") },
    });
  });

  test("after a relaunch with no SessionStart, a resume line lost twice is recorded against the new session in the pane", async () => {
    const context = await setUp("type: context, action: new");
    const { provider, relaunches } = fakeProvider();
    const fake = fakeTerminal(() => IDLE);

    await helper(context, fake.terminal, provider);

    expect(typesOf(fake.typed)).toEqual([...typedLine(RESUME), ...typedLine(RESUME)]);
    const lost = (await eventsOf(context.runDir)).filter(
      (event) => event.type === "agent.line.lost",
    );
    expect(lost.map((event) => event.payload)).toEqual([
      { agent: "claude", sessionId: relaunches[0]?.sessionId ?? "", step: "step", line: RESUME },
    ]);
  });
});

// A terminal where Claude takes a typed line only when TAKES says it took that try of it (1 for
// the first time the line is typed): a taken /compact completes the compaction, and a taken
// resume line runs the --resume skill.
const losingTerminal = (
  context: Context,
  takes: (line: string, attempt: number) => boolean,
  screen: (captures: number, typed: readonly Typed[]) => string = () => IDLE,
) => {
  const attempts = new Map<string, number>();
  const fake = fakeTerminal(screen, async (text) => {
    const attempt = (attempts.get(text) ?? 0) + 1;
    attempts.set(text, attempt);
    if (!takes(text, attempt)) return;
    if (text === RESUME) await resumed(context.run);
    if (text.startsWith("/compact")) {
      await completeContextOnSessionStart(context.run, "A", "compact");
    }
  });
  return { ...fake, attempts };
};

const completions = async (runDir: string) =>
  (await typesIn(runDir)).filter((type) => type === "workflow.node.completed").length;

describe("runContextStep: compact", () => {
  test("records the start and, with the input box on screen, types /compact with the prompt once and no Escape; the compact's SessionStart completes the node, and the resume line follows and is confirmed by the run's orchestrate resume", async () => {
    const context = await setUp('type: context, action: compact, prompt: "keep the plan"');
    const fake = losingTerminal(context, () => true);

    await helper(context, fake.terminal);

    expect(typesOf(fake.typed)).toEqual([
      ...typedLine("/compact keep the plan"),
      ...typedLine(RESUME),
    ]);
    expect(await typesIn(context.runDir)).toEqual([
      "workflow.context.started",
      "workflow.node.completed",
      "orchestrate.resume",
    ]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "compact", applied: true, sessionId: "A" },
    });
  });

  test("C-u follows the Escape only after Claude's 50 ms escape timeout, so Claude reads a lone Escape and not Alt+C-u", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = losingTerminal(
      context,
      () => true,
      (_, typed) => (escapesIn(typed) === 0 ? CONFIG_LIST_FOOTER : IDLE),
    );
    const sentAt: Readonly<{ key: string; at: number }>[] = [];
    const terminal: ITerminal = {
      ...fake.terminal,
      sendKeys: async (keys) => {
        sentAt.push({ key: keys[0] ?? "", at: Date.now() });
        return fake.terminal.sendKeys(keys);
      },
    };

    await helper(context, terminal);

    const at = (key: string) => sentAt.find((sent) => sent.key === key)?.at ?? Number.NaN;
    expect(at("C-u") - at("Escape")).toBeGreaterThan(50);
  });

  test("a /config popup hiding the input box, with its search box focused, gets exactly 2 Escapes, then /compact is typed", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = losingTerminal(
      context,
      () => true,
      (_, typed) => [CONFIG_SEARCH_FOOTER, CONFIG_LIST_FOOTER][escapesIn(typed)] ?? IDLE,
    );

    await helper(context, fake.terminal);

    expect(typesOf(fake.typed)).toEqual([
      "Escape",
      "Escape",
      ...typedLine("/compact"),
      ...typedLine(RESUME),
    ]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "compact", applied: true },
    });
  });

  test("an input box that never shows gets exactly 3 Escapes and no line, records agent.input.unreachable for step and session A, and ends the compaction unapplied with that reason", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = losingTerminal(
      context,
      () => true,
      () => CONFIG_LIST_FOOTER,
    );

    await helper(context, fake.terminal);

    // 3 for /compact, then 3 for each of the resume line's two tries
    expect(typesOf(fake.typed)).toEqual(Array(9).fill("Escape"));
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "compact", applied: false, reason: "Could not reach Claude's input box" },
    });
    const unreachable = (await eventsOf(context.runDir)).filter(
      (event) => event.type === "agent.input.unreachable",
    );
    expect(unreachable.map((event) => event.payload)).toEqual(
      Array(3).fill({ agent: "claude", sessionId: "A", step: "step" }),
    );
    expect(await typesIn(context.runDir)).toContain("agent.line.lost");
    expect(stateOf(context.runDir).status).toBe("running");
  });

  test("SC2: a resume line lost after a compaction that worked is typed again, and the node stays applied with one completion", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = losingTerminal(context, (line, attempt) => line !== RESUME || attempt === 2);

    await helper(context, fake.terminal);

    expect(typesOf(fake.typed)).toEqual([
      ...typedLine("/compact"),
      ...typedLine(RESUME),
      ...typedLine(RESUME),
    ]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "compact", applied: true, sessionId: "A" },
    });
    expect(await completions(context.runDir)).toBe(1);
    expect(await typesIn(context.runDir)).not.toContain("agent.line.lost");
  });

  test("SC3: a /compact Claude never takes is typed once; with no SessionStart in 180 seconds the step completes unapplied, records no lost line, and the resume line is still typed and taken", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = losingTerminal(context, (line) => line === RESUME);
    const startedAt = Date.now();

    await helper(context, fake.terminal);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180_000);
    expect(typesOf(fake.typed)).toEqual([...typedLine("/compact"), ...typedLine(RESUME)]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: {
        action: "compact",
        applied: false,
        reason: "no SessionStart for the compact within 180 seconds",
      },
    });
    expect(await typesIn(context.runDir)).not.toContain("agent.line.lost");
    expect(stateOf(context.runDir).status).toBe("running");
    // Its 720 polls each read the event log, which outlasts 5s under a parallel run.
  }, 20_000);

  test("SC4: a Claude still finishing its turn, its input box on screen, gets no Escape and /compact at once, and the compaction completes applied", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = losingTerminal(
      context,
      () => true,
      () => BUSY,
    );

    await helper(context, fake.terminal);

    expect(typesOf(fake.typed)).toEqual([...typedLine("/compact"), ...typedLine(RESUME)]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "compact", applied: true, sessionId: "A" },
    });
  });

  test("SC7: Claude saying there is nothing to compact ends the step at once with that reason, not after the 180-second wait, and the resume line is typed", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = losingTerminal(
      context,
      (line) => line === RESUME,
      (captures) => (captures < 2 ? IDLE : REFUSED),
    );
    const startedAt = Date.now();

    await helper(context, fake.terminal);

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(typesOf(fake.typed)).toEqual([...typedLine("/compact"), ...typedLine(RESUME)]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "compact", applied: false, reason: "Not enough messages to compact." },
    });
  });

  test("an orchestrate resume recorded before the helper started does not confirm the resume line, so it is typed again and recorded lost", async () => {
    const context = await setUp("type: context, action: compact");
    await resumed(context.run);
    const fake = losingTerminal(context, (line) => line !== RESUME);

    await helper(context, fake.terminal);

    expect(typesOf(fake.typed)).toEqual([
      ...typedLine("/compact"),
      ...typedLine(RESUME),
      ...typedLine(RESUME),
    ]);
    expect(await typesIn(context.runDir)).toContain("agent.line.lost");
  });

  test("a resume line typed while Claude finishes a turn is not typed again while Claude shows busy, though that takes longer than the 30-second window", async () => {
    const context = await setUp("type: context, action: compact");
    let typedAt: number | undefined;
    const busyFor = 100_000;
    const fake = fakeTerminal(
      () => (typedAt === undefined || Date.now() < typedAt + busyFor ? BUSY : IDLE),
      async (text) => {
        if (text === RESUME) typedAt = Date.now();
        else await completeContextOnSessionStart(context.run, "A", "compact");
      },
    );
    let took = false;
    const terminal: ITerminal = {
      ...fake.terminal,
      capture: async (lines) => {
        if (!took && typedAt !== undefined && Date.now() >= typedAt + busyFor) {
          took = true;
          await resumed(context.run);
        }
        return fake.terminal.capture(lines);
      },
    };

    await helper(context, terminal);

    expect(typesOf(fake.typed)).toEqual([...typedLine("/compact"), ...typedLine(RESUME)]);
    expect(await typesIn(context.runDir)).not.toContain("agent.line.lost");
  }, 20_000);

  test("SC13: a resume line lost on both tries after a compaction that worked records agent.line.lost for step, session A and the line, leaves the run running with no blocker, and leaves the node applied", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = losingTerminal(context, (line) => line !== RESUME);

    await helper(context, fake.terminal);

    expect(typesOf(fake.typed)).toEqual([
      ...typedLine("/compact"),
      ...typedLine(RESUME),
      ...typedLine(RESUME),
    ]);
    const lost = (await eventsOf(context.runDir)).filter(
      (event) => event.type === "agent.line.lost",
    );
    expect(lost.map((event) => event.payload)).toEqual([
      { agent: "claude", sessionId: "A", step: "step", line: RESUME },
    ]);
    expect(stateOf(context.runDir).status).toBe("running");
    expect(stateOf(context.runDir).blocker).toBeUndefined();
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "compact", applied: true, sessionId: "A" },
    });
  });

  test("SC14: a /compact Claude refuses with nothing to compact, then a resume line it takes, records no agent.line.lost and leaves the run running", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = losingTerminal(
      context,
      (line) => line === RESUME,
      (captures) => (captures < 2 ? IDLE : REFUSED),
    );

    await helper(context, fake.terminal);

    expect(await typesIn(context.runDir)).not.toContain("agent.line.lost");
    expect(stateOf(context.runDir).status).toBe("running");
  });
});

describe("completeContextOnSessionStart", () => {
  const started = (context: Context, action: "new" | "compact", sessionId: string) =>
    appendRunEvent(context.run, {
      type: "workflow.context.started",
      source: "orchestrate",
      payload: { nodeRunId: "nr-1", action, sessionId },
    });

  test("only a session start that matches the started action completes the node", async () => {
    const context = await setUp("type: context, action: new");
    await completeContextOnSessionStart(context.run, "s-new", "startup");
    expect(await stepOutput(context.runDir)).toBeUndefined();

    await started(context, "new", "s-new");
    await completeContextOnSessionStart(context.run, "s-other", "startup");
    await completeContextOnSessionStart(context.run, "s-new", "compact");
    expect(await stepOutput(context.runDir)).toBeUndefined();

    await completeContextOnSessionStart(context.run, "s-new", "startup");
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "new", applied: true, sessionId: "s-new" },
    });
  });
});

describe("runContextStep: guards", () => {
  test("of two helpers started at once for the same node, only one goes ahead", async () => {
    const context = await setUp("type: context, action: new");
    const first = startingProvider(context);
    const second = startingProvider(context);

    // Each helper pauses on its first screen check, so both are past their node lookup before
    // either completes the node: without the lock, both would go ahead.
    const slowTerminal = () => {
      const { terminal } = fakeTerminal(() => IDLE);
      // a real 50ms pause: Bun.sleep is faked in these tests
      const capture = async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return terminal.capture();
      };
      return { ...terminal, capture };
    };
    await Promise.all([
      helper(context, slowTerminal(), first.provider),
      helper(context, slowTerminal(), second.provider),
    ]);

    expect(first.relaunches.length + second.relaunches.length).toBe(1);
    expect(existsSync(join(context.runDir, "locks", "context-nr-1.lock"))).toBe(true);
    expect(await typesIn(context.runDir)).toEqual([
      "workflow.session.replaced",
      "workflow.context.started",
      "workflow.node.completed",
    ]);
  });

  test("outside tmux the node completes unapplied and nothing is relaunched", async () => {
    const context = await setUp("type: context, action: new");
    const { provider, relaunches } = fakeProvider();

    await helper(context, undefined, provider);

    expect(relaunches).toEqual([]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "new", applied: false, reason: "not inside tmux" },
    });
  });

  test("a tmux call that throws completes the node unapplied and still resumes the run", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = resumingTerminal(context.run);
    let captures = 0;
    const terminal: ITerminal = {
      ...fake.terminal,
      capture: (lines) => {
        captures += 1;
        if (captures === 1) return Promise.reject(new Error("tmux timed out after 10s"));
        return fake.terminal.capture(lines);
      },
    };

    await helper(context, terminal);

    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "compact", applied: false, reason: "tmux timed out after 10s" },
    });
    expect(typesOf(fake.typed)).toEqual(typedLine(RESUME));
  });
});

// A run with an open model switch to opus-x (and EFFORT); gives back the request's seq.
const setUpSwitch = async (effort?: "high") => {
  const context = await setUp("type: context, action: new");
  const requested = await appendRunEvent(context.run, {
    type: "workflow.model.requested",
    source: "workflow",
    payload: { node: "think", model: "opus-x", ...(effort === undefined ? {} : { effort }) },
  });
  if (!requested.ok) throw new Error(requested.error);
  return { ...context, seq: requested.value.event.seq };
};

const modelHelper = (
  context: Context & Readonly<{ seq: number }>,
  terminal: ITerminal | undefined,
  provider: IAgentProvider = fakeProvider().provider,
  seq = context.seq,
) =>
  runModelStep({
    run: context.run,
    seq,
    sessionId: "s-1",
    terminal,
    provider,
    launch: LAUNCH,
    home: HOME,
    log: noopLogger,
  });

const sessionStarted = (run: RunRef, sessionId: string, source: string) =>
  appendRunEvent(run, {
    type: "hooks.session-start.called",
    source: "hooks",
    payload: { agent: "claude", sessionId, source },
  });

// A provider whose relaunch plays the resumed Claude: its SessionStart hook fires with source resume.
const resumingProvider = (context: Context) => {
  const fake = fakeProvider();
  const provider: IAgentProvider = {
    ...fake.provider,
    relaunch: async (terminal, sessionId, options) => {
      const relaunched = await fake.provider.relaunch(terminal, sessionId, options);
      await sessionStarted(context.run, sessionId, "resume");
      return relaunched;
    },
  };
  return { provider, relaunches: fake.relaunches };
};

const appliedEvents = async (runDir: string) =>
  (await eventsOf(runDir))
    .filter((event) => event.type === "workflow.model.applied")
    .map((event) => event.payload);

describe("runModelStep", () => {
  test("SC25: resumes session s-1 on opus-x at high effort with the resume prompt, records the switch, and types nothing", async () => {
    const context = await setUpSwitch("high");
    const pane = fakeTerminal(() => IDLE);
    const { provider, relaunches } = resumingProvider(context);

    await modelHelper(context, pane.terminal, provider);

    expect(relaunches).toHaveLength(1);
    expect(relaunches[0]?.sessionId).toBe("s-1");
    expect(relaunches[0]?.options).toMatchObject({
      resume: true,
      model: "opus-x",
      effort: "high",
      prompt: RESUME,
    });
    expect(await appliedEvents(context.runDir)).toEqual([
      { requestSeq: context.seq, node: "think", model: "opus-x", effort: "high", applied: true },
    ]);
    expect(pane.typed).toEqual([]);
  });

  test("SC26: a request for opus-x with no effort relaunches with no effort key", async () => {
    const context = await setUpSwitch();
    const { provider, relaunches } = resumingProvider(context);

    await modelHelper(context, fakeTerminal(() => IDLE).terminal, provider);

    expect(relaunches[0]?.options.model).toBe("opus-x");
    expect(relaunches[0]?.options).not.toHaveProperty("effort");
  });

  test("SC9, SC27: a relaunch that fails with respawn failed is recorded as failed, and the resume prompt is typed once at the input box and taken", async () => {
    const context = await setUpSwitch("high");
    const pane = resumingTerminal(context.run);
    const provider: IAgentProvider = {
      ...fakeProvider().provider,
      relaunch: async () => ({ ok: false, error: "respawn failed" }),
    };

    await modelHelper(context, pane.terminal, provider);

    expect(await appliedEvents(context.runDir)).toEqual([
      {
        requestSeq: context.seq,
        node: "think",
        model: "opus-x",
        effort: "high",
        applied: false,
        reason: "respawn failed",
      },
    ]);
    expect(typesOf(pane.typed)).toEqual(typedLine(RESUME));
  });

  test("a resumed session with no SessionStart within 60 seconds, counting none from before the relaunch, is recorded as failed and the run resumed", async () => {
    const context = await setUpSwitch();
    await sessionStarted(context.run, "s-1", "resume");
    const pane = resumingTerminal(context.run);

    await modelHelper(context, pane.terminal);

    expect(await appliedEvents(context.runDir)).toEqual([
      {
        requestSeq: context.seq,
        node: "think",
        model: "opus-x",
        applied: false,
        reason: "no SessionStart within 60 seconds after resuming on opus-x",
      },
    ]);
    expect(typesOf(pane.typed)).toEqual(typedLine(RESUME));
  });

  test("SC15: of two helpers started for the same switch, only one relaunches and stores the result", async () => {
    const context = await setUpSwitch();
    // a real 50ms pause on each screen check: Bun.sleep is faked in these tests
    const slowPane = () => {
      const pane = fakeTerminal(() => IDLE);
      const capture = async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return pane.terminal.capture();
      };
      return { ...pane.terminal, capture };
    };
    const { provider, relaunches } = fakeProvider();

    await Promise.all([
      modelHelper(context, slowPane(), provider),
      modelHelper(context, slowPane(), provider),
    ]);

    expect(relaunches).toHaveLength(1);
    expect(await appliedEvents(context.runDir)).toHaveLength(1);
  });

  test("a helper whose pid write into model-N.lock fails with ENOSPC still runs the switch it claimed", async () => {
    const context = await setUpSwitch();
    const { provider, relaunches } = fakeProvider();
    const probe = await open(join(context.runDir, "probe"), "w");
    // every FileHandle shares this prototype, so the helper's own handle fails its write
    const handle: FileHandle = Object.getPrototypeOf(probe);
    await probe.close();
    const write = spyOn(handle, "writeFile").mockRejectedValueOnce(new Error("ENOSPC"));

    await modelHelper(context, fakeTerminal(() => IDLE).terminal, provider);

    expect(write).toHaveBeenCalledTimes(1);
    expect(relaunches).toHaveLength(1);
    expect(await appliedEvents(context.runDir)).toHaveLength(1);
  });

  test("a helper for a seq that is not the pending request, or for one already answered, relaunches nothing and stores nothing", async () => {
    const context = await setUpSwitch();
    const pane = fakeTerminal(() => IDLE);
    const { provider, relaunches } = fakeProvider();

    await modelHelper(context, pane.terminal, provider, context.seq + 1);
    const answer = { requestSeq: context.seq, node: "think", model: "opus-x", applied: true };
    await appendRunEvent(context.run, {
      type: "workflow.model.applied",
      source: "t",
      payload: answer,
    });
    await modelHelper(context, pane.terminal, provider);

    expect(relaunches).toEqual([]);
    expect(pane.typed).toEqual([]);
    expect(await appliedEvents(context.runDir)).toEqual([answer]);
  });

  test("a result that cannot be stored releases the switch's lock, so the next stop's helper relaunches again", async () => {
    const context = await setUpSwitch();
    const module = join(context.run.cwd, "refuse.ts");
    writeFileSync(module, 'export const refuse = () => { throw new Error("disk full"); };\n');
    const statePath = join(context.runDir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const eventHandlers = { "workflow.model.applied": [{ module, handler: "refuse" }] };
    writeFileSync(statePath, JSON.stringify({ ...state, eventHandlers }));
    const { provider, relaunches } = fakeProvider();

    await modelHelper(context, fakeTerminal(() => IDLE).terminal, provider);
    await modelHelper(context, fakeTerminal(() => IDLE).terminal, provider);

    expect(relaunches).toHaveLength(2);
    expect(await appliedEvents(context.runDir)).toEqual([]);
  });

  test("outside tmux the switch is recorded as failed: not inside tmux", async () => {
    const context = await setUpSwitch();

    await modelHelper(context, undefined);

    expect(await appliedEvents(context.runDir)).toEqual([
      {
        requestSeq: context.seq,
        node: "think",
        model: "opus-x",
        applied: false,
        reason: "not inside tmux",
      },
    ]);
  });
});

describe("findOpenContextRun", () => {
  const nodeRun = (nodeType: string, status: string, nodes?: Record<string, unknown>) =>
    ({
      nodeRunId: `${nodeType}-${status}`,
      nodeType,
      status,
      startedAt: null,
      completedAt: null,
      artifacts: [],
      ...(nodes === undefined ? {} : { nodes }),
    }) as unknown as NodeRun;

  test("SC15: a running context step is found at the top level and inside a loop, a completed one is not", () => {
    const inLoop = { loop: nodeRun("loop", "running", { c: nodeRun("context", "running") }) };
    const done = { c: nodeRun("context", "completed"), a: nodeRun("agent", "running") };
    expect(findOpenContextRun(inLoop)?.nodeRunId).toBe("context-running");
    expect(findOpenContextRun({ c: nodeRun("context", "running") })).toBeDefined();
    expect(findOpenContextRun(done)).toBeUndefined();
  });
});

describe("clearDeadSwitchLocks", () => {
  const deadPid = async (): Promise<number> => {
    const child = Bun.spawn(["true"]);
    await child.exited;
    return child.pid;
  };

  test("SC630: model-3.lock and context-nr-2.lock with a dead pid and an empty model-4.lock are removed; context-nr-1.lock held by this process and the state and subscriber lock folders stay", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "switch-locks-"));
    const locks = join(runDir, "locks");
    mkdirSync(join(locks, "state.lock"), { recursive: true });
    mkdirSync(join(locks, "subscriber-notify.lock"));
    const dead = String(await deadPid());
    writeFileSync(join(locks, "model-3.lock"), dead);
    writeFileSync(join(locks, "context-nr-2.lock"), dead);
    writeFileSync(join(locks, "context-nr-1.lock"), String(process.pid));
    writeFileSync(join(locks, "model-4.lock"), "");

    const { removed, held } = await clearDeadSwitchLocks(runDir, seed(runDir), []);

    expect([...removed].sort()).toEqual(["context-nr-2.lock", "model-3.lock", "model-4.lock"]);
    expect(held).toEqual(["context-nr-1.lock"]);
    expect(readdirSync(locks).sort()).toEqual([
      "context-nr-1.lock",
      "state.lock",
      "subscriber-notify.lock",
    ]);
  });

  test("SC631: model-1.lock claimed by a helper holds this process's pid and survives the clear while switch 1 is still requested", async () => {
    const context = await setUp("type: context, action: new");

    await modelHelper({ ...context, seq: 1 }, fakeTerminal(() => IDLE).terminal);
    const requested = await appendRunEvent(context.run, {
      type: "workflow.model.requested",
      source: "workflow",
      payload: { node: "think", model: "opus-x" },
    });

    const lock = join(context.runDir, "locks", "model-1.lock");
    expect(requested.ok && requested.value.event.seq).toBe(1);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    const events = await jsonlEventStore(context.runDir).read();
    expect(await clearDeadSwitchLocks(context.runDir, seed(context.runDir), events)).toEqual({
      removed: [],
      held: ["model-1.lock"],
    });
    expect(existsSync(lock)).toBe(true);
  });

  test("a model lock whose switch was applied and a context lock whose node completed are removed though both hold this live process's pid, since a finished helper's pid can belong to another process", async () => {
    const context = await setUpSwitch();
    await appendRunEvent(context.run, {
      type: "workflow.model.applied",
      source: "t",
      payload: { requestSeq: context.seq, node: "think", model: "opus-x", applied: true },
    });
    const locks = join(context.runDir, "locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `model-${context.seq}.lock`), String(process.pid));
    writeFileSync(join(locks, "context-nr-1.lock"), String(process.pid));
    const step: NodeRun = {
      nodeRunId: "nr-1",
      nodeType: "context",
      status: "completed",
      startedAt: "2026-09-26T10:00:00Z",
      completedAt: "2026-09-26T10:01:00Z",
      artifacts: [],
      input: null,
    };
    const state = { ...seed(context.runDir), nodeRuns: { step } };
    const events = await jsonlEventStore(context.runDir).read();

    const { removed, held } = await clearDeadSwitchLocks(context.runDir, state, events);

    expect([...removed].sort()).toEqual(["context-nr-1.lock", `model-${context.seq}.lock`]);
    expect(held).toEqual([]);
    expect(readdirSync(locks)).toEqual([]);
  });

  test("a model-5.lock holding a live pid but written before the last boot is removed, since a reboot can hand its pid to another process", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "switch-locks-"));
    const lock = join(runDir, "locks", "model-5.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, String(process.pid));
    const beforeBoot = new Date(Date.now() - uptime() * 1000 - 60_000);
    utimesSync(lock, beforeBoot, beforeBoot);

    expect(await clearDeadSwitchLocks(runDir, seed(runDir), [])).toEqual({
      removed: ["model-5.lock"],
      held: [],
    });
    expect(existsSync(lock)).toBe(false);
  });

  test("SC632: a run folder with no locks folder clears nothing and creates nothing", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "switch-locks-"));

    expect(await clearDeadSwitchLocks(runDir, seed(runDir), [])).toEqual({ removed: [], held: [] });
    expect(readdirSync(runDir)).toEqual([]);
  });
});
