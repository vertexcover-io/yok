import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Event,
  type IStorage,
  type JsonValue,
  type NodeRun,
  noopLogger,
  type PreToolUseHandler,
  readState,
  runDirOf,
  type State,
  type ToolCall,
  type ToolUse,
  type ToolVerdict,
} from "@yok/sdk";
import { appendRunEvent, memoryStorage } from "@yok/sdk/internal";
import {
  bashAntipatterns,
  databaseFileOf,
  questionGuard,
  questionNotice,
  recordGuard,
  recordResumed,
  runPreToolUse,
} from "./pre-tool-use.ts";

describe("databaseFileOf", () => {
  const where = { cwd: "/repo", home: "/home/u", yokHome: "/home/u/.yok" };
  const recordAt = (path: string) => databaseFileOf(path, where);

  test("SC7 — only yok.db and its -wal and -shm files are protected, however the home is spelled", () => {
    expect(recordAt("/home/u/.yok/yok.db")).toBe("/home/u/.yok/yok.db");
    expect(recordAt("~/.yok/yok.db")).toBe("/home/u/.yok/yok.db");
    expect(recordAt("$YOK_HOME/yok.db-wal")).toBe("/home/u/.yok/yok.db-wal");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell form under test
    expect(recordAt("${YOK_HOME}/yok.db-shm")).toBe("/home/u/.yok/yok.db-shm");
    for (const path of [
      ".yok/feat-x/state.json",
      "/home/u/.yok/registry.json",
      "/home/u/.yok/yok.db.bak",
      "docs/yok.db",
    ]) {
      expect(recordAt(path)).toBeUndefined();
    }
  });
});

const NOW = "2026-09-26T10:00:00Z";

// Run r-1 in a temp repo, owned by claude session s1: named feat-x with no state, or, given a
// state, named and started with it as init leaves it.
const setUp = async (state?: (runDir: string, cwd: string) => State) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pre-tool-home-")));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pre-tool-repo-")));
  const storage = memoryStorage();
  await storage.projects.add("repo", { path: cwd, addedBy: { channel: "cli" }, addedAt: NOW });
  await storage.runs.addRun({
    id: "r-1",
    project: "repo",
    workflow: "feature",
    workflowPath: join(cwd, "workflow.yaml"),
    inputs: {},
    sessions: [{ agent: "claude", sessionId: "s1" }],
    name: state === undefined ? "feat-x" : null,
    terminal: null,
    config: null,
    tiers: null,
    createdAt: NOW,
  });
  const runDir = runDirOf(cwd, "feat-x");
  await mkdir(runDir, { recursive: true });
  if (state !== undefined) {
    const claimed = await storage.runs.initRun("r-1", "feat-x", state(runDir, cwd));
    if (!claimed.ok) throw new Error(claimed.error);
  }
  const deps = { storage, env: { YOK_RUN_ID: "r-1", YOK_HOME: home }, log: noopLogger };
  const events = () => storage.runs.readEvents("r-1");
  return { cwd, home, runDir, deps, events };
};

const use = (cwd: string, call: ToolCall, overrides: Partial<ToolUse> = {}): ToolUse => ({
  agent: "claude",
  sessionId: "s1",
  toolName: "Write",
  subagent: false,
  cwd,
  call,
  ...overrides,
});
const running = (runDir: string, cwd: string): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "feat-x",
  runDir,
  version: "2.0.0",
  workflow: { name: "feature", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: cwd,
    repositories: { app: { path: cwd, git: { branch: "b", baseBranch: "main", startSha: "a" } } },
  },
  nodeRuns: {},
  activeSessions: [],
  tiers: null,
  eventHandlers: {},
  subscribers: {},
});
const write = (path: string): ToolCall => ({ kind: "file-write", path });
const shell = (command: string): ToolCall => ({ kind: "shell", command });

describe("recordGuard through runPreToolUse", () => {
  test("SC214: a Write to yok.db, rm of yok.db-wal and cp onto yok.db-shm are refused naming the path and the orchestrate commands; a Write to notes.txt and a read of yok.db are allowed", async () => {
    const { cwd, home, deps } = await setUp();
    const refused = [
      use(cwd, write(join(home, "yok.db"))),
      use(cwd, shell(`rm ${home}/yok.db-wal`), { toolName: "Bash" }),
      use(cwd, shell("cp x $YOK_HOME/yok.db-shm"), { toolName: "Bash" }),
    ];
    const paths = ["yok.db", "yok.db-wal", "yok.db-shm"].map((file) => join(home, file));

    const verdicts = await Promise.all(
      refused.map((call) => runPreToolUse(call, recordGuard, deps)),
    );

    verdicts.forEach((verdict, index) => {
      expect(verdict).toMatchObject({ kind: "deny", path: paths[index] });
      const message = verdict.kind === "deny" ? verdict.message : "";
      expect(message).toContain(`${paths[index]} is yok's database`);
      expect(message).toContain("Change a run only through `yok orchestrate`");
    });
    const allowed = [
      use(cwd, write(join(home, "notes.txt"))),
      use(cwd, shell(`sqlite3 ${home}/yok.db 'select 1'`), { toolName: "Bash" }),
    ];
    for (const call of allowed) {
      expect(await runPreToolUse(call, recordGuard, deps)).toEqual({ kind: "allow" });
    }
  });

  test("a SQL client is not judged by its SQL: reads and writes through sqlite3, python or bun -e are allowed", async () => {
    const { cwd, home, deps } = await setUp();
    const commands = [
      `sqlite3 $YOK_HOME/yok.db "select id from runs where name like 'create%'"`,
      `sqlite3 ${home}/yok.db "select replace(name, '-', ' ') from runs"`,
      'sqlite3 ~/.yok/yok.db "delete from events"',
      `python3 -c "import sqlite3; sqlite3.connect('${home}/yok.db').execute('delete from runs')"`,
      `bun -e "new (require('bun:sqlite').Database)('$YOK_HOME/yok.db').run('drop table events')"`,
      `cat ${home}/yok.db | head -c 100`,
      "yok orchestrate events --run feat-x",
    ];

    for (const command of commands) {
      const verdict = await runPreToolUse(
        use(cwd, shell(command), { toolName: "Bash" }),
        recordGuard,
        deps,
      );
      expect({ command, verdict }).toEqual({ command, verdict: { kind: "allow" } });
    }
  });

  test("SC8, SC23 — a write tool on yok.db is refused with the orchestrate commands, and logged", async () => {
    const { cwd, home, deps, events } = await setUp();

    const verdict = await runPreToolUse(use(cwd, write("$YOK_HOME/yok.db")), recordGuard, deps);

    const path = join(home, "yok.db");
    expect(verdict).toMatchObject({ kind: "deny", path });
    const message = verdict.kind === "deny" ? verdict.message : "";
    expect(message).toContain("Change a run only through `yok orchestrate`");
    expect(message).toContain("(`next`, `exec`, `done`, `emit`, `link-session`)");
    expect(message).not.toContain("bun run");
    expect((await events()).map((event) => event.payload)).toEqual([
      {
        agent: "claude",
        sessionId: "s1",
        tool: "Write",
        handler: "record-guard",
        decision: "deny",
        message,
        path,
      },
    ]);
  });

  test("SC9, SC23 — a shell rm of yok.db is refused with link-session among the commands", async () => {
    const { cwd, deps } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, shell("rm $YOK_HOME/yok.db"), { toolName: "Bash" }),
      recordGuard,
      deps,
    );

    const message = verdict.kind === "deny" ? verdict.message : "";
    expect(message).toContain("link-session");
    expect(message).not.toContain("bun run");
  });

  test("SC10 — other writes pass and are not logged", async () => {
    const { cwd, deps, events } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, write(".yok/feat-x/artifacts/plan.md")),
      recordGuard,
      deps,
    );

    expect(verdict).toEqual({ kind: "allow" });
    expect(await events()).toEqual([]);
  });

  test("SC11 — a failing handler allows, and a failing log still answers", async () => {
    const { cwd, deps } = await setUp();
    const boom: PreToolUseHandler = {
      name: "boom",
      run: async () => {
        throw new Error("boom");
      },
    };

    expect(await runPreToolUse(use(cwd, write("notes.md")), boom, deps)).toEqual({ kind: "allow" });

    const storage: IStorage = {
      ...deps.storage,
      runs: {
        ...deps.storage.runs,
        findRun: async () => {
          throw new Error("yok.db down");
        },
      },
    };
    const second = await runPreToolUse(use(cwd, write("$YOK_HOME/yok.db")), recordGuard, {
      ...deps,
      storage,
    });
    expect(second.kind).toBe("deny");
  });

  test("SC12 — a session the run does not own is still guarded but not logged", async () => {
    const { cwd, deps, events } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, write("$YOK_HOME/yok.db"), { sessionId: "other" }),
      recordGuard,
      deps,
    );

    expect(verdict.kind).toBe("deny");
    expect(await events()).toEqual([]);
  });
});

describe("on a blocked run", () => {
  // setUp's run started running, blocked by the given agent event when one is given.
  const runBlockedBy = async (type?: string, payload?: JsonValue) => {
    const setup = await setUp(running);
    const run = { id: "r-1", cwd: setup.cwd, name: "feat-x" };
    if (type !== undefined && payload !== undefined) {
      const appended = await appendRunEvent(setup.deps.storage, run, {
        type,
        source: "hooks",
        payload,
      });
      expect(appended.ok).toBe(true);
    }
    return { ...setup, run };
  };
  const limitWaiting = {
    sessionId: "s1",
    limitEventId: "evt-0",
    resumeAt: "2026-09-26T14:00:00Z",
    from: "message",
  };
  const question = {
    agent: "claude",
    sessionId: "s1",
    questions: [{ question: "Ship it?", options: ["Yes", "No"] }],
  };
  const resumedEvents = async (events: () => Promise<readonly Event[]>) =>
    (await events()).filter((event) => event.type === "agent.resumed");

  test.each([
    ["usage-limit", "agent.limit.waiting", limitWaiting],
    ["question", "agent.question.asked", question],
  ] as const)(
    "SC143: recordResumed allows a Bash call on a run blocked by %s and appends one agent.resumed with that reason, and the run reads running",
    async (reason, type, payload) => {
      const { cwd, run, deps, events } = await runBlockedBy(type, payload);
      expect((await readState(run, deps.storage))?.status).toBe("blocked");

      const verdict = await runPreToolUse(
        use(cwd, shell("bun test"), { toolName: "Bash" }),
        recordResumed,
        deps,
      );

      expect(verdict).toEqual({ kind: "allow" });
      expect((await resumedEvents(events)).map((event) => event.payload)).toEqual([
        { agent: "claude", sessionId: "s1", reason, tool: "Bash" },
      ]);
      const state = await readState(run, deps.storage);
      expect(state?.status).toBe("running");
      expect(state).not.toHaveProperty("blocker");
    },
  );

  test("a sub-agent's Bash call on a question-blocked run is allowed but appends nothing, and the run stays blocked", async () => {
    const { cwd, run, deps, events } = await runBlockedBy("agent.question.asked", question);

    const verdict = await runPreToolUse(
      use(cwd, shell("bun test"), { toolName: "Bash", subagent: true }),
      recordResumed,
      deps,
    );

    expect(verdict).toEqual({ kind: "allow" });
    expect(await resumedEvents(events)).toEqual([]);
    expect((await readState(run, deps.storage))?.blocker?.reason).toBe("question");
  });

  const failing = async () => {
    throw new Error("yok.db unreadable");
  };
  test.each([
    ["its state cannot be read", { readState: failing }],
    ["its events cannot be stored", { appendEvent: failing }],
  ])(
    "recordResumed still allows a Bash call on a blocked run when %s, so a failed record never refuses a call",
    async (_label, broken) => {
      const { cwd, deps, events } = await runBlockedBy("agent.question.asked", question);
      const storage: IStorage = {
        ...deps.storage,
        runs: { ...deps.storage.runs, ...broken },
      };

      const verdict = await recordResumed.run(use(cwd, shell("bun test"), { toolName: "Bash" }), {
        ...deps,
        storage,
      });

      expect(verdict).toEqual({ kind: "allow" });
      expect(await resumedEvents(events)).toEqual([]);
    },
  );

  test("two Bash calls at once on a question-blocked run append one agent.resumed between them", async () => {
    const { cwd, deps, events } = await runBlockedBy("agent.question.asked", question);
    const bash = use(cwd, shell("bun test"), { toolName: "Bash" });

    const verdicts = await Promise.all([
      runPreToolUse(bash, recordResumed, deps),
      runPreToolUse(bash, recordResumed, deps),
    ]);

    expect(verdicts).toEqual([{ kind: "allow" }, { kind: "allow" }]);
    expect(await resumedEvents(events)).toHaveLength(1);
  });

  test("SC143: recordResumed allows a Write on a running run and appends nothing", async () => {
    const { cwd, deps, events } = await runBlockedBy();

    const verdict = await runPreToolUse(use(cwd, write("notes.md")), recordResumed, deps);

    expect(verdict).toEqual({ kind: "allow" });
    expect(await events()).toEqual([]);
  });

  test("recordGuard only guards: on a blocked run it appends nothing for a call it allows and only its deny log for one it refuses, and the run stays blocked", async () => {
    const { cwd, run, deps, events } = await runBlockedBy("agent.limit.waiting", limitWaiting);

    const allowed = await runPreToolUse(
      use(cwd, shell("bun test"), { toolName: "Bash" }),
      recordGuard,
      deps,
    );
    const denied = await runPreToolUse(use(cwd, write("$YOK_HOME/yok.db")), recordGuard, deps);

    expect(allowed).toEqual({ kind: "allow" });
    expect(denied.kind).toBe("deny");
    expect((await events()).map((event) => event.type)).toEqual([
      "agent.limit.waiting",
      "hooks.pre-tool-use.called",
    ]);
    expect((await readState(run, deps.storage))?.status).toBe("blocked");
  });
});

describe("a question in a run", () => {
  const ask: ToolCall = {
    kind: "question",
    questions: [{ question: "Which database?", options: ["Postgres", "SQLite"] }],
  };
  const design: NodeRun = {
    nodeRunId: "design-1",
    nodeType: "agent",
    status: "running",
    startedAt: "2026-09-26T10:00:00Z",
    completedAt: null,
    artifacts: [],
  };
  // setUp's run with these nodes open, saved with the given interaction policy, or with none.
  const runWithOpen = async (nodeRuns: Record<string, NodeRun>, interaction?: boolean) => {
    const policies =
      interaction === undefined
        ? {}
        : { policies: { values: { interaction }, sources: { interaction: "cli" as const } } };
    const setup = await setUp((runDir, cwd) => ({
      ...running(runDir, cwd),
      nodeRuns,
      ...policies,
    }));
    return { ...setup, run: { id: "r-1", cwd: setup.cwd, name: "feat-x" } };
  };
  const runWithDesignOpen = (interaction?: boolean) => runWithOpen({ design }, interaction);

  test("SC520: with interaction off, questionGuard refuses the question with the node's done command and records policy.applied, while questionNotice records no question and the run stays running", async () => {
    const { cwd, run, deps, events } = await runWithDesignOpen(false);
    const call = use(cwd, ask, { toolName: "AskUserQuestion" });

    const guarded = await runPreToolUse(call, questionGuard, deps);
    const noticed = await runPreToolUse(call, questionNotice, deps);

    const message = guarded.kind === "deny" ? guarded.message : "";
    expect(message).toStartWith("No one will answer in this run.");
    expect(message).toContain("`yok orchestrate done design-1 --run feat-x --error -`");
    expect(noticed).toEqual({ kind: "allow" });
    const stored = await events();
    expect(stored.filter((event) => event.type === "policy.applied").map((e) => e.payload)).toEqual(
      [{ policy: "interaction", effect: "question-refused", nodeId: "design" }],
    );
    expect(stored.map((event) => event.type)).not.toContain("agent.question.asked");
    expect((await readState(run, deps.storage))?.status).toBe("running");
  });

  test("SC22: with interaction off and subagent review open before inline write, the refusal names write's done command and policy.applied names write", async () => {
    const review = { ...design, nodeRunId: "review-1", mode: "subagent" as const };
    const write = { ...design, nodeRunId: "write-1", mode: "inline" as const };
    const { cwd, deps, events } = await runWithOpen({ review, write }, false);

    const verdict = await runPreToolUse(
      use(cwd, ask, { toolName: "AskUserQuestion" }),
      questionGuard,
      deps,
    );

    expect(verdict.kind === "deny" ? verdict.message : "").toContain(
      "`yok orchestrate done write-1 --run feat-x --error -`",
    );
    const stored = await events();
    expect(stored.filter((event) => event.type === "policy.applied").map((e) => e.payload)).toEqual(
      [{ policy: "interaction", effect: "question-refused", nodeId: "write" }],
    );
  });

  test("with interaction off and subagent review open beside inline write, a question from the subagent is refused naming no done command, and policy.applied names no node", async () => {
    const review = { ...design, nodeRunId: "review-1", mode: "subagent" as const };
    const write = { ...design, nodeRunId: "write-1", mode: "inline" as const };
    const { cwd, deps, events } = await runWithOpen({ review, write }, false);

    const verdict = await runPreToolUse(
      use(cwd, ask, { toolName: "AskUserQuestion", subagent: true }),
      questionGuard,
      deps,
    );

    const message = verdict.kind === "deny" ? verdict.message : "";
    expect(message).toStartWith("No one will answer in this run.");
    expect(message).not.toContain("orchestrate");
    const stored = await events();
    expect(stored.filter((event) => event.type === "policy.applied").map((e) => e.payload)).toEqual(
      [{ policy: "interaction", effect: "question-refused" }],
    );
  });

  test("with interaction off inside a loop, the refusal names the running agent node by its own id, and between the loop's children it names next, not the loop", async () => {
    const loop = (nodes: Record<string, NodeRun>): NodeRun => ({
      ...design,
      nodeRunId: "loop-1",
      nodeType: "loop",
      nodes,
    });
    const inFix = await runWithOpen(
      { review: loop({ fix: { ...design, nodeRunId: "fix-1" } }) },
      false,
    );
    const between = await runWithOpen({ review: loop({}) }, false);
    const ask_ = (cwd: string) => use(cwd, ask, { toolName: "AskUserQuestion" });

    const fixVerdict = await runPreToolUse(ask_(inFix.cwd), questionGuard, inFix.deps);
    const betweenVerdict = await runPreToolUse(ask_(between.cwd), questionGuard, between.deps);

    const messageOf = (verdict: ToolVerdict) => (verdict.kind === "deny" ? verdict.message : "");
    expect(messageOf(fixVerdict)).toContain("`yok orchestrate done fix-1 --run feat-x --error -`");
    expect(messageOf(betweenVerdict)).toContain("`yok orchestrate next --run feat-x`");
    expect(messageOf(betweenVerdict)).not.toContain("orchestrate done");
    const applied = async (events: () => Promise<readonly Event[]>) =>
      (await events())
        .filter((event) => event.type === "policy.applied")
        .map((event) => event.payload);
    expect(await applied(inFix.events)).toEqual([
      { policy: "interaction", effect: "question-refused", nodeId: "fix" },
    ]);
    expect(await applied(between.events)).toEqual([
      { policy: "interaction", effect: "question-refused" },
    ]);
  });

  test("SC521 (regression): with no saved policies, or from a session no run knows, questionGuard allows and records nothing, and questionNotice still records the question", async () => {
    const { cwd, deps, events } = await runWithDesignOpen();
    const call = use(cwd, ask, { toolName: "AskUserQuestion" });
    const stranger = use(cwd, ask, { toolName: "AskUserQuestion", sessionId: "s-9" });

    expect(await runPreToolUse(call, questionGuard, deps)).toEqual({ kind: "allow" });
    expect(await runPreToolUse(stranger, questionGuard, deps)).toEqual({ kind: "allow" });
    expect(await events()).toEqual([]);

    expect(await runPreToolUse(call, questionNotice, deps)).toEqual({ kind: "allow" });
    expect((await events()).map((event) => event.type)).toEqual(["agent.question.asked"]);
  });
});

describe("bashAntipatterns", () => {
  const deps = {
    env: {},
    log: noopLogger,
    storage: memoryStorage(),
  };
  const run = (command: string) => bashAntipatterns.run(use(tmpdir(), shell(command)), deps);

  test("SC19 — the vendored script keeps its license and upstream pointer", async () => {
    const text = await readFile(
      join(import.meta.dir, "..", "..", "vendor", "bash-antipatterns.sh"),
      "utf8",
    );

    expect(text.split("\n")[0]).toBe("#!/usr/bin/env bash");
    expect(text).toContain("Copyright (c) 2026 Lauri Gates");
    expect(text).toContain("Permission is hereby granted, free of charge");
    expect(text).toContain(
      "https://github.com/laurigates/claude-plugins/blob/2e07766617d92e8955e9939014e949836b6356ba/hooks-plugin/hooks/bash-antipatterns.sh",
    );
    expect(text).toContain(
      "# PreToolUse hook for Bash tool - detects anti-patterns and reminds Claude",
    );
  });

  test("SC20, SC88 — a shell write to an ordinary file is refused, whichever agent sent it", async () => {
    const verdict = await run("echo hi > notes.md");

    expect(verdict.kind).toBe("deny");
    expect(verdict.kind === "deny" && verdict.message).toContain("Write tool");
  });

  test("SC21, SC88 (regression) — the orchestrate done heredoc still passes", async () => {
    const command = [
      "yok orchestrate done n1 --run feat-x --output - <<'JSON'",
      '{ "ok": true }',
      "JSON",
    ].join("\n");

    expect(await run(command)).toEqual({ kind: "allow" });
  });

  test("a call that is not a shell command is not its concern", async () => {
    expect(await bashAntipatterns.run(use(tmpdir(), write("notes.md")), deps)).toEqual({
      kind: "allow",
    });
  });

  test("SC22, SC88 — a script that cannot run lets the call through", async () => {
    const saved = process.env.PATH;
    // /bin has bash and cat but not jq, which the script needs to read its input.
    process.env.PATH = "/bin";
    try {
      expect(await run("echo hi > notes.md")).toEqual({ kind: "allow" });
    } finally {
      process.env.PATH = saved;
    }
  });
});
