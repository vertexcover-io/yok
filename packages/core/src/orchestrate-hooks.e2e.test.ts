import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type JsonValue, runDirOf, type SavedPolicies, type WorkflowRun } from "@yok/sdk";
import { appendRunEvent } from "@yok/sdk/internal";
import {
  type Env,
  eventsOf,
  orchestrate,
  parseStep,
  readRegistry,
  STAGE_SKILLS,
  STAGES_WORKFLOW,
  savedRun,
  stageSkills,
  startedRun,
  tempDir,
  waitFor,
  withContext,
  writeRegistry,
} from "./test-orchestrate.ts";

const stateOf = (repo: string) =>
  JSON.parse(readFileSync(join(runDirOf(repo, "feat-x"), "state.json"), "utf8"));

const ONE_AGENT = `name: one
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: plan
    type: agent
    prompt: plan it
    input: {}
`;

describe("SC26: orchestrate hook stop", () => {
  const STOP = JSON.stringify({ session_id: "s1", stop_hook_active: false });
  const RUN_ENV = { YOK_RUN_ID: "r-1" };

  // A run whose claude session s1 was handed node plan by next and has not run done.
  const openNodeRun = () => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "s1"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);
    const next = parseStep(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
    expect(next).toMatchObject({ kind: "agent", nodeId: "plan" });
    return run;
  };

  const stop = (run: Readonly<{ repo: string; home: string }>, input = STOP, env: Env = RUN_ENV) =>
    orchestrate(
      run.repo,
      run.home,
      ["hook", "stop", "--agent", "claude", "--handler", "continue-workflow"],
      env,
      input,
    );

  test("SC20 — the hook blocks a turn that left an agent node open, and logs the call", async () => {
    const run = openNodeRun();

    const first = stop(run);

    expect(first.code).toBe(0);
    const reply = JSON.parse(first.stdout);
    expect(reply).toEqual({
      decision: "block",
      reason: expect.stringContaining("orchestrate done"),
    });
    const last = (await eventsOf(run.repo)).at(-1);
    expect(last).toMatchObject({
      type: "hooks.stop.called",
      payload: {
        agent: "claude",
        sessionId: "s1",
        decision: "continue",
        reason: "node-not-done",
        blockStreak: 1,
        message: reply.reason,
      },
    });
    expect(stateOf(run.repo).stopHook).toEqual({ blockStreak: 1, seq: last?.seq });
  });

  // A run between nodes, and a Claude transcript whose last lines are PROMPT and then COMMAND, if any.
  const betweenNodes = (prompt: string, command?: string) => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "s1"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);
    const transcript = join(tempDir(), "s1.jsonl");
    const lines = [
      { type: "user", message: { role: "user", content: prompt } },
      ...(command === undefined
        ? [{ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } }]
        : [
            {
              type: "assistant",
              message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
            },
          ]),
    ];
    writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join("\n"));
    return { run, input: JSON.stringify({ session_id: "s1", transcript_path: transcript }) };
  };

  test("SC16, SC19: with subagent review and inline write handed out by one next, state.json records each mode, and a stop while the review runs in the background sends the agent back to write's done once, then lets the turn end with no agent.stuck", async () => {
    const run = startedRun(`name: mixed
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: a, type: exec, runtime: sh, script: printf a, input: {} }
  - { id: review, type: agent, prompt: review it, mode: subagent, dependsOn: [a], input: {} }
  - { id: write, type: agent, prompt: write it, dependsOn: [a], input: {} }
`);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "s1"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);
    const a = parseStep(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
    expect(orchestrate(run.repo, run.home, ["exec", a.nodeRunId, "--run", "feat-x"]).code).toBe(0);
    const both = JSON.parse(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
    expect(both.steps.map((step: { nodeId: string }) => step.nodeId)).toEqual(["review", "write"]);
    const { review, write } = stateOf(run.repo).nodeRuns;
    expect([review.mode, write.mode]).toEqual(["subagent", "inline"]);
    const waiting = JSON.stringify({
      session_id: "s1",
      stop_hook_active: false,
      background_tasks: [{ type: "subagent", status: "running" }],
    });

    const first = stop(run, waiting);
    const second = stop(run, waiting);

    expect(JSON.parse(first.stdout)).toEqual({
      decision: "block",
      reason: expect.stringContaining(`yok orchestrate done ${write.nodeRunId} --run feat-x`),
    });
    expect(second).toMatchObject({ code: 0, stdout: "" });
    const events = await eventsOf(run.repo);
    const stops = events.filter((event) => event.type === "hooks.stop.called");
    expect(stops.map((event) => event.payload)).toEqual([
      expect.objectContaining({ reason: "node-not-done" }),
      expect.objectContaining({ reason: "background-task" }),
    ]);
    expect(events.map((event) => event.type)).not.toContain("agent.stuck");
  });

  test("a turn that ran orchestrate but not next is sent back with the next command", () => {
    const { run, input } = betweenNodes("go", "yok orchestrate done n1 --run feat-x");

    const reply = JSON.parse(stop(run, input).stdout);

    expect(reply.reason).toContain("yok orchestrate next --run feat-x");
  });

  test("SC23 — a broken state.json lets the turn end", () => {
    const run = openNodeRun();
    writeFileSync(join(runDirOf(run.repo, "feat-x"), "state.json"), '{"schemaVersion":2}');

    expect(stop(run)).toMatchObject({ code: 0, stdout: "" });
  });

  describe("orchestrate await-approval", () => {
    const awaitingRun = () => {
      const run = openNodeRun();
      mkdirSync(join(runDirOf(run.repo, "feat-x"), "artifacts"), { recursive: true });
      writeFileSync(join(runDirOf(run.repo, "feat-x"), "artifacts", "design.md"), "# Design\n");
      const nodeRunId: string = stateOf(run.repo).nodeRuns.plan.nodeRunId;
      return { ...run, nodeRunId };
    };
    const awaitApproval = (
      run: Readonly<{ repo: string; home: string }>,
      nodeRunId: string,
      file: string,
    ) =>
      orchestrate(run.repo, run.home, [
        "await-approval",
        nodeRunId,
        "--run",
        "feat-x",
        "--file",
        file,
      ]);
    const approvalRequests = async (repo: string) =>
      (await eventsOf(repo)).filter((event) => event.type === "artifact.approval.requested");

    test("SC5: await-approval on the open agent node records the request, and the next stop is let through as awaiting-approval", async () => {
      const run = awaitingRun();

      const reply = awaitApproval(run, run.nodeRunId, "artifacts/design.md");

      expect(reply.code).toBe(0);
      expect(JSON.parse(reply.stdout)).toEqual({
        nodeRunId: run.nodeRunId,
        path: "artifacts/design.md",
      });
      expect(await approvalRequests(run.repo)).toEqual([
        expect.objectContaining({
          nodeId: "plan",
          nodeRunId: run.nodeRunId,
          payload: { path: "artifacts/design.md" },
        }),
      ]);
      expect(stop(run)).toMatchObject({ code: 0, stdout: "" });
      expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
        type: "hooks.stop.called",
        payload: { decision: "allow", reason: "awaiting-approval", nodeRunId: run.nodeRunId },
      });
    });

    test("SC6: await-approval refuses an unknown node run, a missing file, a file outside artifacts/ and a directory under it, writing no request", async () => {
      const run = awaitingRun();
      writeFileSync(join(runDirOf(run.repo, "feat-x"), "notes.md"), "notes\n");
      mkdirSync(join(runDirOf(run.repo, "feat-x"), "artifacts", "drafts"));

      const replies = [
        awaitApproval(run, "nr-unknown", "artifacts/design.md"),
        awaitApproval(run, run.nodeRunId, "artifacts/missing.md"),
        awaitApproval(run, run.nodeRunId, "notes.md"),
        awaitApproval(run, run.nodeRunId, "artifacts/drafts"),
      ];

      expect(replies.map((reply) => reply.code)).toEqual([1, 1, 1, 1]);
      expect(replies[0]?.stderr).toContain("nr-unknown");
      expect(replies[1]?.stderr).toContain("artifacts/missing.md");
      expect(replies[2]?.stderr).toContain("notes.md");
      expect(replies[3]?.stderr).toContain("artifacts/drafts");
      expect(await approvalRequests(run.repo)).toEqual([]);
    });

    test("SC518: with interaction off, await-approval approves at once, records policy.applied, and done then completes the node", async () => {
      const policies: SavedPolicies = {
        values: { interaction: false, learning: true },
        sources: { interaction: "cli" },
      };
      const run = startedRun(ONE_AGENT, undefined, { policies });
      const next = parseStep(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
      mkdirSync(join(runDirOf(run.repo, "feat-x"), "artifacts"), { recursive: true });
      writeFileSync(join(runDirOf(run.repo, "feat-x"), "artifacts", "design.md"), "# Design\n");

      const reply = awaitApproval(run, next.nodeRunId, "artifacts/design.md");

      expect(reply.code).toBe(0);
      expect(JSON.parse(reply.stdout)).toEqual({
        nodeRunId: next.nodeRunId,
        path: "artifacts/design.md",
        autoApproved: true,
      });
      expect(stateOf(run.repo).nodeRuns.plan.awaitingApproval).toBeUndefined();
      expect(stateOf(run.repo).autoApproved).toEqual(["artifacts/design.md"]);
      const events = await eventsOf(run.repo);
      expect(events.filter((event) => event.type === "policy.applied")).toEqual([
        expect.objectContaining({
          nodeRunId: next.nodeRunId,
          payload: {
            policy: "interaction",
            effect: "auto-approved",
            nodeId: "plan",
            path: "artifacts/design.md",
          },
        }),
      ]);
      expect(await approvalRequests(run.repo)).toEqual([]);
      const finish = ["--summary", "Planned.", "--output", "{}"];
      const done = ["done", next.nodeRunId, "--run", "feat-x", ...finish];
      expect(orchestrate(run.repo, run.home, done).code).toBe(0);
      expect(stateOf(run.repo).nodeRuns.plan.status).toBe("completed");
    });

    const writePlan = (repo: string, title: string) => {
      const artifacts = join(runDirOf(repo, "feat-x"), "artifacts");
      mkdirSync(join(artifacts, "phases"), { recursive: true });
      writeFileSync(join(artifacts, "plan.md"), `# ${title}\n`);
      writeFileSync(join(artifacts, "phases", "phase-1.md"), "# Phase 1: Export\n");
    };
    const planPage = (repo: string) => join(runDirOf(repo, "feat-x"), "artifacts", "plan.html");
    const pageTitle = (repo: string) =>
      readFileSync(planPage(repo), "utf8").match(/<title>(.*)<\/title>/)?.[1];

    test("SC712: await-approval on artifacts/plan.html builds the page from the current plan.md each time it is asked", async () => {
      const run = awaitingRun();
      writePlan(run.repo, "Plan: Export");

      const first = awaitApproval(run, run.nodeRunId, "artifacts/plan.html");

      expect(first.code).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual({
        nodeRunId: run.nodeRunId,
        path: "artifacts/plan.html",
      });
      expect(pageTitle(run.repo)).toBe("Plan: Export");
      expect(await approvalRequests(run.repo)).toEqual([
        expect.objectContaining({ payload: { path: "artifacts/plan.html" } }),
      ]);

      writePlan(run.repo, "Plan: Export v2");
      expect(awaitApproval(run, run.nodeRunId, "artifacts/plan.html").code).toBe(0);
      expect(pageTitle(run.repo)).toBe("Plan: Export v2");
    });

    test("SC713: await-approval on artifacts/plan.html with no plan.md fails naming plan.md and records no request", async () => {
      const run = awaitingRun();

      const reply = awaitApproval(run, run.nodeRunId, "artifacts/plan.html");

      expect(reply.code).toBe(1);
      expect(reply.stderr).toContain("plan.md");
      expect(reply.stderr).toContain("artifacts/plan.html was not rebuilt");
      expect(await approvalRequests(run.repo)).toEqual([]);
    });

    test("SC714: with interaction off, await-approval still builds artifacts/plan.html before auto-approving it", async () => {
      const policies: SavedPolicies = {
        values: { interaction: false, learning: true },
        sources: { interaction: "cli" },
      };
      const run = startedRun(ONE_AGENT, undefined, { policies });
      const next = parseStep(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
      writePlan(run.repo, "Plan: Export");

      const reply = awaitApproval(run, next.nodeRunId, "artifacts/plan.html");

      expect(reply.code).toBe(0);
      expect(JSON.parse(reply.stdout)).toMatchObject({ autoApproved: true });
      expect(existsSync(planPage(run.repo))).toBe(true);
      const events = await eventsOf(run.repo);
      expect(events.filter((event) => event.type === "policy.applied")).toHaveLength(1);
    });

    test("SC715: await-approval on artifacts/design.md writes no plan.html", () => {
      const run = awaitingRun();
      writePlan(run.repo, "Plan: Export");

      expect(awaitApproval(run, run.nodeRunId, "artifacts/design.md").code).toBe(0);
      expect(existsSync(planPage(run.repo))).toBe(false);
    });
  });
});

describe("SC26: orchestrate hook pre-tool-use", () => {
  const RUN_ENV = { YOK_RUN_ID: "r-1" };

  const openNodeRun = () => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "s1"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);
    const next = parseStep(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
    expect(next).toMatchObject({ kind: "agent", nodeId: "plan" });
    return run;
  };

  const preToolUse = (
    run: Readonly<{ repo: string; home: string }>,
    toolName: string,
    toolInput: Record<string, unknown>,
    handler = "record-guard",
  ) =>
    orchestrate(
      run.repo,
      run.home,
      ["hook", "pre-tool-use", "--agent", "claude", "--handler", handler],
      RUN_ENV,
      JSON.stringify({
        session_id: "s1",
        tool_name: toolName,
        tool_input: toolInput,
        cwd: run.repo,
      }),
    );

  test("SC144: after the real stop-failure hook blocks the run on an agent error, a Bash call through the real record-resumed hook puts state.json back to running with no blocker", async () => {
    const run = openNodeRun();
    const failed = orchestrate(
      run.repo,
      run.home,
      ["hook", "stop-failure", "--agent", "claude", "--handler", "record-agent-error"],
      RUN_ENV,
      JSON.stringify({ session_id: "s1", error: "authentication_failed" }),
    );
    expect(failed).toMatchObject({ code: 0, stdout: "" });
    expect(stateOf(run.repo)).toMatchObject({
      status: "blocked",
      blocker: { reason: "agent-error", node: "plan" },
    });

    const result = preToolUse(run, "Bash", { command: "bun test" }, "record-resumed");

    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
      type: "agent.resumed",
      payload: { agent: "claude", sessionId: "s1", reason: "agent-error", tool: "Bash" },
    });
    const state = stateOf(run.repo);
    expect(state.status).toBe("running");
    expect(state).not.toHaveProperty("blocker");
  });

  test("an unknown handler prints nothing, so no agent is ever trapped", () => {
    const run = openNodeRun();

    const result = preToolUse(run, "Bash", { command: "rm .yok/feat-x/state.json" }, "nope");

    expect(result).toMatchObject({ code: 0, stdout: "" });
  });
});

describe("SC26: a question blocks the run", () => {
  test("SC136: the real AskUserQuestion hooks block the run on the make stage in state.json, and its answer unblocks it", () => {
    const run = startedRun(STAGES_WORKFLOW);
    const env = { YOK_SKILLS_DIR: stageSkills() };
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "s1"];
    expect(orchestrate(run.repo, run.home, link, env).code).toBe(0);
    const next = parseStep(
      orchestrate(run.repo, run.home, ["next", "--run", "feat-x"], env).stdout,
    );
    expect(next).toMatchObject({ kind: "stage", nodeId: "make" });

    const question = "Ship the plan as is?";
    const toolInput = {
      questions: [
        { question, header: "Plan", options: [{ label: "Approve" }, { label: "Revise" }] },
      ],
    };
    const call = { session_id: "s1", tool_name: "AskUserQuestion", tool_use_id: "tu-1" };
    const hook = (event: string, handler: string, input: Record<string, unknown>) =>
      orchestrate(
        run.repo,
        run.home,
        ["hook", event, "--agent", "claude", "--handler", handler],
        { YOK_RUN_ID: "r-1" },
        JSON.stringify({ ...call, ...input }),
      );

    expect(
      hook("pre-tool-use", "question-notice", { tool_input: toolInput, cwd: run.repo }).code,
    ).toBe(0);
    expect(stateOf(run.repo)).toMatchObject({
      status: "blocked",
      blocker: {
        reason: "question",
        node: "make",
        details: { questions: [{ question, header: "Plan", options: ["Approve", "Revise"] }] },
      },
    });

    const answered = hook("post-tool-use", "answer-notice", {
      tool_input: toolInput,
      tool_response: { answers: { [question]: "Approve" } },
    });
    expect(answered.code).toBe(0);
    const state = stateOf(run.repo);
    expect(state.status).toBe("running");
    expect(state).not.toHaveProperty("blocker");
  });
});

describe("SC26: orchestrate hook session-start", () => {
  const RUN_ENV = { YOK_RUN_ID: "r-1" };
  const START = JSON.stringify({ session_id: "B", source: "clear", cwd: "/x" });

  const sessionStart = (
    run: Readonly<{ repo: string; home: string }>,
    input = START,
    env: Env = RUN_ENV,
  ) =>
    orchestrate(
      run.repo,
      run.home,
      ["hook", "session-start", "--agent", "claude", "--handler", "link-session"],
      env,
      input,
    );

  test("SC10: a new session id after /clear is linked to its run and its Stop hook call is recognized", async () => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "A"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);

    const result = sessionStart(run);

    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect(readRegistry(run.home).runs["r-1"]?.sessions).toEqual([
      { agent: "claude", sessionId: "A" },
      { agent: "claude", sessionId: "B" },
    ]);
    expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
      type: "hooks.session-start.called",
      payload: { agent: "claude", sessionId: "B", source: "clear" },
    });
    const stop = orchestrate(
      run.repo,
      run.home,
      ["hook", "stop", "--agent", "claude", "--handler", "continue-workflow"],
      RUN_ENV,
      JSON.stringify({ session_id: "B" }),
    );
    expect(stop.code).toBe(0);
    expect((await eventsOf(run.repo)).at(-1)?.type).toBe("hooks.stop.called");
  });

  test("SC11: a session with no run is left alone, and one on a run with no name yet is linked without an event", async () => {
    const run = startedRun(ONE_AGENT);
    const before = (await eventsOf(run.repo)).length;
    const registryBefore = readRegistry(run.home);

    expect(sessionStart(run, START, {})).toMatchObject({ code: 0, stdout: "" });
    expect(sessionStart(run, START, { YOK_RUN_ID: "unknown" })).toMatchObject({
      code: 0,
      stdout: "",
    });

    expect(readRegistry(run.home)).toEqual(registryBefore);
    expect(await eventsOf(run.repo)).toHaveLength(before);

    const home = tempDir();
    writeRegistry(home, [savedRun(run.repo)]);
    expect(sessionStart({ repo: run.repo, home })).toMatchObject({ code: 0, stdout: "" });
    expect(readRegistry(home).runs["r-1"]?.sessions).toEqual([{ agent: "claude", sessionId: "B" }]);
    expect(await eventsOf(run.repo)).toHaveLength(before);
  });

  test("SC12: input that is not JSON prints nothing and exits 0", () => {
    const run = startedRun(ONE_AGENT);

    expect(sessionStart(run, "not json")).toMatchObject({ code: 0, stdout: "" });
  });
});

const FAKE_AGENT = join(import.meta.dir, "agents", "fixtures", "fake-agent.ts");

const RESUME = "/yok:orchestrate --resume feat-x";

// A run whose agent is the fake agent in a private tmux pane, on session A; ENV goes to every call.
const runInPane = async (
  source: string,
  socket: string,
  overrides: Partial<WorkflowRun> = {},
  env: Env = {},
) => {
  const run = startedRun(source, undefined, overrides, {
    env: { YOK_SKILLS_DIR: STAGE_SKILLS, ...env },
  });
  const out = join(tempDir(), "agent.jsonl");
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
  tmux(
    ...["new-session", "-d", "-s", "agent", "-x", "200", "-y", "50", "-c", run.repo],
    ...["-e", `FAKE_AGENT_OUT=${out}`, "--", "bun", FAKE_AGENT],
  );
  const socketPath = tmux("display-message", "-p", "-t", "agent", "#{socket_path}").trim();
  const pane = tmux("display-message", "-p", "-t", "agent", "#{pane_id}").trim();
  const inPane = {
    TMUX: `${socketPath},1,0`,
    TMUX_PANE: pane,
    YOK_CLAUDE_BIN: FAKE_AGENT,
  };
  const step = (args: readonly string[], extra: Env = {}, input = "") =>
    orchestrate(run.repo, run.home, args, { YOK_RUN_ID: "r-1", ...env, ...extra }, input);
  const next = () => parseStep(step(["next", "--run", "feat-x"]).stdout);
  const records = (): Array<Record<string, unknown>> =>
    existsSync(out)
      ? readFileSync(out, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line))
      : [];
  const typed = () =>
    records()
      .map((record) => record.line)
      .filter((line): line is string => typeof line === "string");
  const launches = () => records().filter((record) => Array.isArray(record.argv));

  expect(
    step(["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "A"]).code,
  ).toBe(0);
  await waitFor(() => launches().length === 1);
  await Bun.sleep(300);
  const stop = () =>
    step(
      ["hook", "stop", "--agent", "claude", "--handler", "continue-workflow"],
      inPane,
      JSON.stringify({ session_id: "A" }),
    );
  // What Claude does once a new session starts or a compact finishes: run its SessionStart hook.
  const sessionStart = (sessionId: string, source: string) =>
    step(
      ["hook", "session-start", "--agent", "claude", "--handler", "link-session"],
      inPane,
      JSON.stringify({ session_id: sessionId, source }),
    );
  return { run, step, next, stop, sessionStart, typed, launches };
};

// A run in a tmux pane (runInPane), driven to its context node.
const runToContextNode = async (
  node: string,
  socket: string,
  overrides: Partial<WorkflowRun> = {},
  header = "",
) => {
  const flow = await runInPane(header + withContext(node), socket, overrides);
  const first = flow.next();
  expect(
    flow.step([
      "done",
      first.nodeRunId,
      "--run",
      "feat-x",
      "--summary",
      "Did the work.",
      "--output",
      "{}",
    ]).code,
  ).toBe(0);
  return { ...flow, context: flow.next() };
};

const contextOutput = async (repo: string) =>
  (await eventsOf(repo)).find(
    (event) => event.type === "workflow.node.completed" && event.nodeId === "fresh",
  )?.payload;

describe("SC26: context node through a real tmux pane", () => {
  test("new: the helper restarts the agent in its pane on a new session, whose SessionStart completes the node", async () => {
    const socket = `yok-e2e-${crypto.randomUUID()}`;
    try {
      const flow = await runToContextNode("action: new", socket);
      expect(flow.context).toMatchObject({ kind: "context", action: "new", nodeId: "fresh" });

      expect(flow.stop()).toMatchObject({ code: 0, stdout: "" });
      await waitFor(() => flow.launches().length === 2);

      const argv = flow.launches()[1]?.argv as string[];
      const sessionId = argv[argv.indexOf("--session-id") + 1] ?? "";
      expect(argv.at(-1)).toBe(RESUME);
      expect(await contextOutput(flow.run.repo)).toBeUndefined();
      expect(flow.sessionStart(sessionId, "startup")).toMatchObject({ code: 0, stdout: "" });
      expect(flow.launches()[1]?.runId).toBe("r-1");
      expect(flow.typed()).toEqual([]);
      expect(stateOf(flow.run.repo).activeSessions).toEqual([{ agent: "claude", sessionId }]);
      expect(await contextOutput(flow.run.repo)).toMatchObject({
        output: { action: "new", applied: true, sessionId },
      });
      expect(flow.next()).toMatchObject({ kind: "agent", nodeId: "second" });
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
    }
  }, 30_000);

  test.each([
    [
      "with no switch made, on the default tier's model and effort, and no permission mode",
      { tiers: { default: "deep", models: { deep: { model: "opus", effort: "high" as const } } } },
      undefined,
      { "--model": "opus", "--effort": "high" },
      "--permission-mode",
    ],
    [
      "SC18: after a switch from the default fast tier's sonnet-x to opus-x is applied, with --model opus-x",
      { tiers: { default: "fast", models: { fast: { model: "sonnet-x" } } } },
      "opus-x",
      { "--model": "opus-x" },
      "sonnet-x",
    ],
    [
      "for a trigger's run, in the permission mode saved on the run",
      { tiers: null, permissionMode: "auto" as const },
      undefined,
      { "--permission-mode": "auto" },
      undefined,
    ],
  ])(
    "new: the restarted session launches %s",
    async (_case, overrides, switchTo, flags, absent) => {
      const socket = `yok-e2e-${crypto.randomUUID()}`;
      try {
        const flow = await runToContextNode("action: new", socket, overrides);
        if (switchTo !== undefined) {
          // emit refuses engine-owned events, so the switch is stored the way next and the helper do
          const run = { id: "r-1", cwd: flow.run.repo, name: "feat-x" };
          const record = (type: string, payload: JsonValue) =>
            appendRunEvent(run, { type, source: "orchestrate", payload });
          const request = { node: "second", model: switchTo };
          const requested = await record("workflow.model.requested", request);
          if (!requested.ok) throw new Error(requested.error);
          const requestSeq = requested.value.event.seq;
          expect(
            await record("workflow.model.applied", { ...request, requestSeq, applied: true }),
          ).toMatchObject({ ok: true });
        }

        expect(flow.stop()).toMatchObject({ code: 0, stdout: "" });
        await waitFor(() => flow.launches().length === 2);

        const argv = flow.launches()[1]?.argv as string[];
        const launched = Object.keys(flags).map((flag) => [flag, argv[argv.indexOf(flag) + 1]]);
        expect(Object.fromEntries(launched)).toEqual(flags);
        expect(argv.filter((arg) => arg === absent)).toEqual([]);
      } finally {
        spawnSync("tmux", ["-L", socket, "kill-server"]);
      }
    },
    30_000,
  );

  test("model: before a deep stage on a trigger's run launched on fast in auto, next asks for opus-x; the stop's helper resumes session A on it in auto, and its SessionStart records the switch", async () => {
    const socket = `yok-e2e-${crypto.randomUUID()}`;
    try {
      const flow = await runInPane(
        `name: tiered
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: think, type: agent, stage: thinker, input: {} }
`,
        socket,
        {
          tiers: {
            default: "fast",
            models: { fast: { model: "sonnet-x" }, deep: { model: "opus-x" } },
          },
          permissionMode: "auto",
        },
        { YOK_SKILLS_DIR: stageSkills() },
      );
      expect(flow.next()).toEqual({ kind: "model", nodeId: "think", model: "opus-x" });

      expect(flow.stop()).toMatchObject({ code: 0, stdout: "" });
      await waitFor(() => flow.launches().length === 2);

      const argv = flow.launches()[1]?.argv as string[];
      expect(argv.slice(0, 4)).toEqual(["--resume", "A", "--model", "opus-x"]);
      expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("auto");
      expect(argv.at(-1)).toBe(RESUME);
      expect(flow.sessionStart("A", "resume")).toMatchObject({ code: 0, stdout: "" });
      const modelEvents = async () =>
        (await eventsOf(flow.run.repo)).filter((event) => event.type.startsWith("workflow.model."));
      const deadline = Date.now() + 10_000;
      while ((await modelEvents()).length < 2 && Date.now() < deadline) await Bun.sleep(50);
      const [requested, applied] = await modelEvents();
      expect(applied?.payload).toEqual({
        requestSeq: requested?.seq ?? 0,
        node: "think",
        model: "opus-x",
        applied: true,
      });
      expect(flow.next()).toMatchObject({ kind: "stage", nodeId: "think" });
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
    }
  }, 30_000);

  test("SC12: compact: /compact is typed once; its SessionStart completes the node, the resume line is typed once and the run's orchestrate resume confirms it, and next moves on", async () => {
    const socket = `yok-e2e-${crypto.randomUUID()}`;
    const COMPACT = "/compact keep the plan";
    try {
      const flow = await runToContextNode('action: compact, prompt: "keep the plan"', socket);
      expect(flow.context).toMatchObject({ kind: "context", action: "compact" });
      const sessionsBefore = stateOf(flow.run.repo).activeSessions;

      expect(flow.stop()).toMatchObject({ code: 0, stdout: "" });
      await waitFor(() => flow.typed().includes(COMPACT));
      expect(flow.sessionStart("A", "compact")).toMatchObject({ code: 0, stdout: "" });
      await waitFor(() => flow.typed().includes(RESUME));
      // what the --resume skill runs first
      expect(flow.step(["resume", "--run", "feat-x"]).code).toBe(0);

      expect(flow.typed()).toEqual([COMPACT, RESUME]);
      expect(stateOf(flow.run.repo).activeSessions).toEqual(sessionsBefore);
      expect(await contextOutput(flow.run.repo)).toMatchObject({
        output: { action: "compact", applied: true, sessionId: "A" },
      });
      expect(flow.next()).toMatchObject({ kind: "agent", nodeId: "second" });
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
    }
  }, 30_000);
});

describe("SC26: the stop that ends a run's finishing turn closes its tmux pane", () => {
  const sessionGone = (socket: string) =>
    spawnSync("tmux", ["-L", socket, "has-session", "-t", "agent"]).status !== 0;

  // A finished run whose registered terminal is the fake agent's tmux session.
  const finishedRun = async (socket: string) => {
    const flow = await runInPane(
      ONE_AGENT,
      socket,
      { terminal: "agent" },
      { YOK_TMUX_SOCKET: socket },
    );
    const plan = flow.next();
    const done = ["done", plan.nodeRunId, "--run", "feat-x", "--summary", "Planned."];
    expect(flow.step([...done, "--output", "{}"]).code).toBe(0);
    expect(flow.next()).toMatchObject({ kind: "finished", status: "completed" });
    return flow;
  };

  test("SC811: the next that ends the run closes nothing; the finishing session's stop then kills the run's terminal at once, with nothing typed", async () => {
    const socket = `yok-e2e-${crypto.randomUUID()}`;
    try {
      const flow = await finishedRun(socket);
      expect(sessionGone(socket)).toBe(false);

      flow.stop();

      expect(sessionGone(socket)).toBe(true);
      expect(flow.typed()).toEqual([]);
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
    }
  }, 30_000);

  test("SC828: a session resumed after the finish keeps its terminal through its stop", async () => {
    const socket = `yok-e2e-${crypto.randomUUID()}`;
    try {
      const flow = await finishedRun(socket);
      expect(flow.sessionStart("A", "resume").code).toBe(0);

      expect(flow.stop().code).toBe(0);

      expect(sessionGone(socket)).toBe(false);
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
    }
  }, 30_000);
});

describe("SC26: orchestrate hook stop-failure", () => {
  // The test itself may run inside tmux; the helper must not find this pane and type into it.
  const RUN_ENV = { YOK_RUN_ID: "r-1", TMUX: undefined, TMUX_PANE: undefined };

  test("a usage limit is logged as agent.limit.reached and its detached wait starts, which with no terminal only logs why it cannot type", async () => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "A"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);

    const result = orchestrate(
      run.repo,
      run.home,
      ["hook", "stop-failure", "--agent", "claude", "--handler", "resume-after-limit"],
      RUN_ENV,
      JSON.stringify({
        session_id: "A",
        error: "rate_limit",
        last_assistant_message: "resets 3pm (UTC)",
      }),
    );

    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
      type: "agent.limit.reached",
      payload: {
        agent: "claude",
        sessionId: "A",
        error: "rate_limit",
        message: "resets 3pm (UTC)",
      },
    });
    const log = join(runDirOf(run.repo, "feat-x"), "limit-wait.log");
    await waitFor(
      () => existsSync(log) && readFileSync(log, "utf8").includes("no terminal to type into"),
    );
  }, 20_000);
});

describe("SC26: orchestrate hook --agent codex", () => {
  const RUN_ENV = { YOK_RUN_ID: "r-1" };
  const common = { cwd: "/x", hook_event_name: "X", model: "gpt-5", permission_mode: "default" };

  const hook = (
    run: Readonly<{ repo: string; home: string }>,
    event: string,
    handler: string,
    stdin: Record<string, unknown>,
  ) =>
    orchestrate(
      run.repo,
      run.home,
      ["hook", event, "--agent", "codex", "--handler", handler],
      RUN_ENV,
      JSON.stringify({ ...common, transcript_path: null, ...stdin }),
    );

  test("SC12: session-start links the Codex session, pre-tool-use denies a state.json write, stop blocks an open node", async () => {
    const run = startedRun(ONE_AGENT);

    const start = hook(run, "session-start", "link-session", {
      session_id: "c1",
      source: "startup",
    });
    expect(start).toMatchObject({ code: 0, stdout: "" });
    expect(readRegistry(run.home).runs["r-1"]?.sessions).toEqual([
      { agent: "codex", sessionId: "c1" },
    ]);

    const next = parseStep(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
    expect(next).toMatchObject({ kind: "agent", nodeId: "plan" });

    const denied = hook(run, "pre-tool-use", "record-guard", {
      session_id: "c1",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Update File: .yok/feat-x/state.json\n*** End Patch",
      },
      cwd: run.repo,
    });
    expect(JSON.parse(denied.stdout).hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("orchestrate next --run feat-x"),
    });

    const stopped = hook(run, "stop", "continue-workflow", {
      session_id: "c1",
      stop_hook_active: false,
      last_assistant_message: "done",
      turn_id: "t1",
    });
    expect(JSON.parse(stopped.stdout)).toEqual({
      decision: "block",
      reason: expect.stringContaining("orchestrate done"),
    });
    expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
      type: "hooks.stop.called",
      payload: { agent: "codex", sessionId: "c1", decision: "continue" },
    });
  });
});
