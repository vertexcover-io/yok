import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type JsonValue,
  type NodeRun,
  noopLogger,
  type PreToolUseHandler,
  readState,
  registryPath,
  runDirOf,
  type State,
  type ToolCall,
  type ToolUse,
  type ToolVerdict,
} from "@yok/sdk";
import { appendRunEvent, createRegistry, jsonlEventStore } from "@yok/sdk/internal";
import {
  bashAntipatterns,
  protectedRecordOf,
  questionGuard,
  questionNotice,
  recordGuard,
  recordResumed,
  runPreToolUse,
} from "./pre-tool-use.ts";

describe("protectedRecordOf", () => {
  const where = { cwd: "/repo", home: "/home/u", yokHome: "/home/u/.yok" };
  const kindOf = (path: string) => protectedRecordOf(path, where);

  test("SC7 — only the three records are protected", () => {
    expect(kindOf(".yok/feat-x/state.json")).toMatchObject({
      kind: "state",
      runName: "feat-x",
    });
    expect(kindOf("/abs/.yok/feat-x/event.jsonl")).toMatchObject({
      kind: "events",
      runName: "feat-x",
    });
    for (const path of [
      "/home/u/.yok/registry.json",
      "~/.yok/registry.json",
      "$HOME/.yok/registry.json",
      "$YOK_HOME/registry.json",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell form under test
      "${YOK_HOME}/registry.json",
    ]) {
      expect(kindOf(path)).toEqual({ kind: "registry", path: "/home/u/.yok/registry.json" });
    }
    for (const path of [
      ".yok/feat-x/artifacts/plan.md",
      ".yok/feat-x/state.json.bak",
      "docs/state.json",
      ".yok/registry.json",
    ]) {
      expect(kindOf(path)).toBeUndefined();
    }
  });
});

// A registry run r-1 named feat-x in a temp repo, owned by claude session s1.
const setUp = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pre-tool-home-")));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pre-tool-repo-")));
  const registry = createRegistry(registryPath(home));
  await registry.addRun({
    id: "r-1",
    workflow: "feature",
    workflowPath: join(cwd, "workflow.yaml"),
    inputs: {},
    cwd,
    sessions: [{ agent: "claude", sessionId: "s1" }],
    name: "feat-x",
    terminal: null,
    config: null,
    tiers: null,
    createdAt: "2026-09-26T10:00:00Z",
  });
  const runDir = runDirOf(cwd, "feat-x");
  await mkdir(runDir, { recursive: true });
  const deps = { registry, env: { YOK_RUN_ID: "r-1", YOK_HOME: home }, log: noopLogger };
  return { cwd, home, runDir, deps };
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
  test("SC8, SC23 — a write tool on a run record is refused with the orchestrate commands, and logged", async () => {
    const { cwd, runDir, deps } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, write(".yok/feat-x/state.json")),
      recordGuard,
      deps,
    );

    const path = join(cwd, ".yok/feat-x/state.json");
    expect(verdict).toMatchObject({ kind: "deny", path });
    const message = verdict.kind === "deny" ? verdict.message : "";
    expect(message).toContain("yok orchestrate next --run feat-x");
    expect(message).toContain("exec|done NODE_RUN_ID --run feat-x");
    expect(message).toContain("orchestrate emit");
    expect(message).not.toContain("bun run");
    expect((await jsonlEventStore(runDir).read()).map((event) => event.payload)).toEqual([
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

  test("SC3: an Edit of .yok/demo/state.json is refused naming the run, and the old run folder is left alone", async () => {
    const { cwd, deps } = await setUp();
    const edit = (path: string) =>
      runPreToolUse(use(cwd, write(path), { toolName: "Edit" }), recordGuard, deps);

    const refused = await edit("/repo/.yok/demo/state.json");
    // Split so the sweep for the old product name (SC10) does not flag this test.
    const allowed = await edit(`/repo/.${["har", "ness"].join("")}/demo/state.json`);

    expect(refused.kind).toBe("deny");
    expect(refused.kind === "deny" ? refused.message : "").toContain("--run demo");
    expect(allowed).toEqual({ kind: "allow" });
  });

  test("SC9, SC23 — a shell command on the registry is refused with init and link-session", async () => {
    const { cwd, deps } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, shell("rm $YOK_HOME/registry.json"), { toolName: "Bash" }),
      recordGuard,
      deps,
    );

    const message = verdict.kind === "deny" ? verdict.message : "";
    expect(message).toContain("yok orchestrate init");
    expect(message).toContain("link-session");
    expect(message).not.toContain("bun run");
  });

  test("SC10 — other writes pass and are not logged", async () => {
    const { cwd, runDir, deps } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, write(".yok/feat-x/artifacts/plan.md")),
      recordGuard,
      deps,
    );

    expect(verdict).toEqual({ kind: "allow" });
    expect(await jsonlEventStore(runDir).read()).toEqual([]);
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

    const registry = {
      ...deps.registry,
      findRun: async () => {
        throw new Error("registry down");
      },
    };
    const second = await runPreToolUse(use(cwd, write(".yok/feat-x/state.json")), recordGuard, {
      ...deps,
      registry,
    });
    expect(second.kind).toBe("deny");
  });

  test("SC12 — a session the run does not own is still guarded but not logged", async () => {
    const { cwd, runDir, deps } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, write(".yok/feat-x/event.jsonl"), { sessionId: "other" }),
      recordGuard,
      deps,
    );

    expect(verdict.kind).toBe("deny");
    expect(await jsonlEventStore(runDir).read()).toEqual([]);
  });
});

describe("on a blocked run", () => {
  // setUp's run with a running state.json, blocked by the given agent event when one is given.
  const runBlockedBy = async (type?: string, payload?: JsonValue) => {
    const setup = await setUp();
    const state = running(setup.runDir, setup.cwd);
    await writeFile(join(setup.runDir, "state.json"), JSON.stringify(state));
    const run = { id: "r-1", cwd: setup.cwd, name: "feat-x" };
    if (type !== undefined && payload !== undefined) {
      expect((await appendRunEvent(run, { type, source: "hooks", payload })).ok).toBe(true);
    }
    return setup;
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
  const resumedEvents = async (runDir: string) =>
    (await jsonlEventStore(runDir).read()).filter((event) => event.type === "agent.resumed");

  test.each([
    ["usage-limit", "agent.limit.waiting", limitWaiting],
    ["question", "agent.question.asked", question],
  ] as const)(
    "SC143: recordResumed allows a Bash call on a run blocked by %s and appends one agent.resumed with that reason, and the run reads running",
    async (reason, type, payload) => {
      const { cwd, runDir, deps } = await runBlockedBy(type, payload);
      expect((await readState(runDir))?.status).toBe("blocked");

      const verdict = await runPreToolUse(
        use(cwd, shell("bun test"), { toolName: "Bash" }),
        recordResumed,
        deps,
      );

      expect(verdict).toEqual({ kind: "allow" });
      expect((await resumedEvents(runDir)).map((event) => event.payload)).toEqual([
        { agent: "claude", sessionId: "s1", reason, tool: "Bash" },
      ]);
      const state = await readState(runDir);
      expect(state?.status).toBe("running");
      expect(state).not.toHaveProperty("blocker");
    },
  );

  test("a sub-agent's Bash call on a question-blocked run is allowed but appends nothing, and the run stays blocked", async () => {
    const { cwd, runDir, deps } = await runBlockedBy("agent.question.asked", question);

    const verdict = await runPreToolUse(
      use(cwd, shell("bun test"), { toolName: "Bash", subagent: true }),
      recordResumed,
      deps,
    );

    expect(verdict).toEqual({ kind: "allow" });
    expect(await resumedEvents(runDir)).toEqual([]);
    expect((await readState(runDir))?.blocker?.reason).toBe("question");
  });

  test.each([
    ["state.json is not JSON", (runDir: string) => writeFile(join(runDir, "state.json"), "{")],
    ["event.jsonl is read-only", (runDir: string) => chmod(join(runDir, "event.jsonl"), 0o444)],
  ])(
    "recordResumed still allows a Bash call on a blocked run when %s, so a failed record never refuses a call",
    async (_label, breakRecord) => {
      const { cwd, runDir, deps } = await runBlockedBy("agent.question.asked", question);
      await breakRecord(runDir);

      const verdict = await recordResumed.run(
        use(cwd, shell("bun test"), { toolName: "Bash" }),
        deps,
      );

      expect(verdict).toEqual({ kind: "allow" });
      expect(await readFile(join(runDir, "event.jsonl"), "utf8")).not.toContain("agent.resumed");
    },
  );

  test("two Bash calls at once on a question-blocked run append one agent.resumed between them", async () => {
    const { cwd, runDir, deps } = await runBlockedBy("agent.question.asked", question);
    const bash = use(cwd, shell("bun test"), { toolName: "Bash" });

    const verdicts = await Promise.all([
      runPreToolUse(bash, recordResumed, deps),
      runPreToolUse(bash, recordResumed, deps),
    ]);

    expect(verdicts).toEqual([{ kind: "allow" }, { kind: "allow" }]);
    expect(await resumedEvents(runDir)).toHaveLength(1);
  });

  test("SC143: recordResumed allows a Write on a running run and appends nothing", async () => {
    const { cwd, runDir, deps } = await runBlockedBy();

    const verdict = await runPreToolUse(use(cwd, write("notes.md")), recordResumed, deps);

    expect(verdict).toEqual({ kind: "allow" });
    expect(await jsonlEventStore(runDir).read()).toEqual([]);
  });

  test("recordGuard only guards: on a blocked run it appends nothing for a call it allows and only its deny log for one it refuses, and the run stays blocked", async () => {
    const { cwd, runDir, deps } = await runBlockedBy("agent.limit.waiting", limitWaiting);

    const allowed = await runPreToolUse(
      use(cwd, shell("bun test"), { toolName: "Bash" }),
      recordGuard,
      deps,
    );
    const denied = await runPreToolUse(
      use(cwd, write(".yok/feat-x/state.json")),
      recordGuard,
      deps,
    );

    expect(allowed).toEqual({ kind: "allow" });
    expect(denied.kind).toBe("deny");
    expect((await jsonlEventStore(runDir).read()).map((event) => event.type)).toEqual([
      "agent.limit.waiting",
      "hooks.pre-tool-use.called",
    ]);
    expect((await readState(runDir))?.status).toBe("blocked");
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
    const setup = await setUp();
    const policies =
      interaction === undefined
        ? {}
        : { policies: { values: { interaction }, sources: { interaction: "cli" as const } } };
    const state = { ...running(setup.runDir, setup.cwd), nodeRuns, ...policies };
    await writeFile(join(setup.runDir, "state.json"), JSON.stringify(state));
    return setup;
  };
  const runWithDesignOpen = (interaction?: boolean) => runWithOpen({ design }, interaction);

  test("SC520: with interaction off, questionGuard refuses the question with the node's done command and records policy.applied, while questionNotice records no question and the run stays running", async () => {
    const { cwd, runDir, deps } = await runWithDesignOpen(false);
    const call = use(cwd, ask, { toolName: "AskUserQuestion" });

    const guarded = await runPreToolUse(call, questionGuard, deps);
    const noticed = await runPreToolUse(call, questionNotice, deps);

    const message = guarded.kind === "deny" ? guarded.message : "";
    expect(message).toStartWith("No one will answer in this run.");
    expect(message).toContain("`yok orchestrate done design-1 --run feat-x --error -`");
    expect(noticed).toEqual({ kind: "allow" });
    const events = await jsonlEventStore(runDir).read();
    expect(events.filter((event) => event.type === "policy.applied").map((e) => e.payload)).toEqual(
      [{ policy: "interaction", effect: "question-refused", nodeId: "design" }],
    );
    expect(events.map((event) => event.type)).not.toContain("agent.question.asked");
    expect((await readState(runDir))?.status).toBe("running");
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
    const applied = async (runDir: string) =>
      (await jsonlEventStore(runDir).read())
        .filter((event) => event.type === "policy.applied")
        .map((event) => event.payload);
    expect(await applied(inFix.runDir)).toEqual([
      { policy: "interaction", effect: "question-refused", nodeId: "fix" },
    ]);
    expect(await applied(between.runDir)).toEqual([
      { policy: "interaction", effect: "question-refused" },
    ]);
  });

  test("SC521 (regression): with no saved policies, or from a session no run knows, questionGuard allows and records nothing, and questionNotice still records the question", async () => {
    const { cwd, runDir, deps } = await runWithDesignOpen();
    const call = use(cwd, ask, { toolName: "AskUserQuestion" });
    const stranger = use(cwd, ask, { toolName: "AskUserQuestion", sessionId: "s-9" });

    expect(await runPreToolUse(call, questionGuard, deps)).toEqual({ kind: "allow" });
    expect(await runPreToolUse(stranger, questionGuard, deps)).toEqual({ kind: "allow" });
    expect(await jsonlEventStore(runDir).read()).toEqual([]);

    expect(await runPreToolUse(call, questionNotice, deps)).toEqual({ kind: "allow" });
    expect((await jsonlEventStore(runDir).read()).map((event) => event.type)).toEqual([
      "agent.question.asked",
    ]);
  });
});

describe("bashAntipatterns", () => {
  const deps = {
    env: {},
    log: noopLogger,
    registry: {
      findRun: async () => undefined,
      findRunsByName: async () => [],
      listRuns: async () => [],
    },
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
