import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  noopLogger,
  type PostToolUseHandler,
  type PostToolUseInput,
  type PreToolUseHandler,
  type RegistryReader,
  registryPath,
  runDirOf,
  type SavedPolicies,
  type State,
  type StopFailureInput,
  type StopHandler,
  type StopInput,
  type ToolCall,
  type ToolUse,
} from "@yok/sdk";
import { createRegistry, jsonlEventStore } from "@yok/sdk/internal";
import { answerNotice } from "../hooks/post-tool-use.ts";
import {
  preToolUseHandlers,
  questionGuard,
  questionNotice,
  recordGuard,
} from "../hooks/pre-tool-use.ts";
import { continueWorkflow, stopHandlers } from "../hooks/stop.ts";
import { recordAgentError } from "../hooks/stop-failure.ts";
import { claudeAdapter, claudeSettings, readClaudeTranscript } from "./claude-hooks.ts";
// Hand-written, not captured from a live session: whether Claude fills tool_input.answers or
// tool_response.answers is still unproven.
import CLAUDE_POST_TOOL_USE_ASK from "./fixtures/claude-post-tool-use-ask.synthetic.json";

const claudeStop = claudeAdapter.stop;
const claudePreToolUse = claudeAdapter.preToolUse;

const NO_RUNS: RegistryReader = {
  findRun: async () => undefined,
  findRunsByName: async () => [],
  listRuns: async () => [],
};

const line = (value: unknown): string => JSON.stringify(value);
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "user", ...extra, message: { role: "user", content } });
const assistant = (content: unknown) =>
  line({ type: "assistant", message: { role: "assistant", content } });

describe("readClaudeTranscript", () => {
  test("SC15 — the Claude transcript reads as prompts, shell commands and other tool calls, in order", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "claude-transcript-")), "s1.jsonl");
    const lines = [
      user("go"),
      assistant([
        { type: "text", text: "Running next." },
        {
          type: "tool_use",
          id: "t1",
          name: "Bash",
          input: { command: "yok orchestrate next --run feat-x" },
        },
      ]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "{}" }]),
      user("Stop hook feedback: node plan is still open", { isMeta: true }),
      user([{ type: "text", text: "Stop hook feedback: run next" }]),
      assistant([{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a" } }]),
      assistant([
        { type: "tool_use", id: "t3", name: "AskUserQuestion", input: { questions: [] } },
      ]),
      "{not json",
      user("<task-notification>task b1 completed</task-notification>", {
        origin: { kind: "task-notification" },
      }),
      user([{ type: "text", text: "why?" }]),
    ];
    await writeFile(path, lines.join("\n"));

    expect(await readClaudeTranscript(path)).toEqual([
      { kind: "prompt", text: "go" },
      { kind: "command", command: "yok orchestrate next --run feat-x" },
      { kind: "tool", name: "Read" },
      { kind: "question" },
      { kind: "prompt", text: "why?" },
    ]);
  });

  test("SC15 — no path, or a path that does not exist, is unknown", async () => {
    expect(await readClaudeTranscript(undefined)).toBeUndefined();
    expect(await readClaudeTranscript(join(tmpdir(), "no-such-transcript.jsonl"))).toBeUndefined();
  });
});

describe("claudeAdapter.stop", () => {
  test("SC16 — input Claude's hook cannot read lets the turn end without looking up a run", async () => {
    let lookups = 0;
    const registry: RegistryReader = {
      findRun: async () => {
        lookups += 1;
        throw new Error("findRun must not be called");
      },
      findRunsByName: async () => [],
      listRuns: async () => [],
    };
    const deps = { registry, env: { YOK_RUN_ID: "r-1" }, log: noopLogger };

    expect(await claudeStop?.("not json", deps, continueWorkflow)).toBe("");
    expect(await claudeStop?.("{}", deps, continueWorkflow)).toBe("");
    expect(lookups).toBe(0);
  });
});

describe("claudeAdapter.stop background_tasks", () => {
  const deps = { registry: NO_RUNS, env: {}, log: noopLogger };
  const waitingOnBackground = async (backgroundTasks: unknown): Promise<boolean | undefined> => {
    const seen: StopInput[] = [];
    const spy: StopHandler = {
      name: "spy",
      run: async (input) => {
        seen.push(input);
        return { kind: "allow" };
      },
    };
    await claudeStop?.(line({ session_id: "s1", background_tasks: backgroundTasks }), deps, spy);
    return seen[0]?.waitingOnBackground;
  };

  test.each([
    ["SC137: a running subagent", true, [{ type: "subagent", status: "running" }]],
    ["SC138: a running shell", true, [{ type: "shell", status: "running" }]],
    ["SC139: an empty list", false, []],
    [
      "SC140: only a completed shell and a failed subagent",
      false,
      [
        { type: "shell", status: "completed" },
        { type: "subagent", status: "failed" },
      ],
    ],
    ["a killed shell", false, [{ type: "shell", status: "killed" }]],
    ["a subagent in an unknown status, pending", true, [{ type: "subagent", status: "pending" }]],
    [
      "a completed shell beside a running subagent",
      true,
      [
        { type: "shell", status: "completed" },
        { type: "subagent", status: "running" },
      ],
    ],
    ["a missing field", false, undefined],
    ["a field that is not a list", false, { type: "shell", status: "running" }],
    [
      "a malformed entry beside a running shell",
      true,
      [{ type: "shell" }, { type: "shell", status: "running" }],
    ],
  ])("%s reads as waiting on background %p", async (_label, waiting, tasks) => {
    expect(await waitingOnBackground(tasks)).toBe(waiting);
  });
});

describe("claudeSettings", () => {
  test("SC8, SC13, SC18, SC303 — the status line and every hook run the orchestrate argv with each argument quoted", () => {
    const argv = "'/usr/bin/bun' '/opt/it'\\''s here/orchestrate.ts'";
    const entry = (event: string, handler: string) => ({
      type: "command",
      command: `${argv} 'hook' '${event}' '--agent' 'claude' '--handler' '${handler}'`,
      timeout: 30,
    });

    expect(claudeSettings(["/usr/bin/bun", "/opt/it's here/orchestrate.ts"])).toEqual({
      statusLine: { type: "command", command: `${argv} 'statusline'`, refreshInterval: 5 },
      hooks: {
        SessionStart: [{ hooks: [entry("session-start", "link-session")] }],
        Stop: [{ hooks: [entry("stop", "continue-workflow")] }],
        StopFailure: [
          { matcher: "rate_limit", hooks: [entry("stop-failure", "resume-after-limit")] },
          { matcher: "*", hooks: [entry("stop-failure", "record-agent-error")] },
        ],
        PreToolUse: [
          {
            matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash",
            hooks: [entry("pre-tool-use", "record-guard"), entry("pre-tool-use", "record-resumed")],
          },
          { matcher: "Bash", hooks: [entry("pre-tool-use", "bash-antipatterns")] },
          {
            matcher: "AskUserQuestion",
            hooks: [
              entry("pre-tool-use", "question-guard"),
              entry("pre-tool-use", "question-notice"),
            ],
          },
        ],
        PostToolUse: [
          { matcher: "AskUserQuestion", hooks: [entry("post-tool-use", "answer-notice")] },
        ],
      },
    });
  });
});

describe("claudeAdapter.preToolUse", () => {
  const deps = { registry: NO_RUNS, env: { YOK_RUN_ID: "r-1" }, log: noopLogger };
  const stdin = (tool_name: string, tool_input: Record<string, unknown>) =>
    JSON.stringify({ session_id: "s1", tool_name, tool_input, cwd: "/repo" });
  const TARGET = ".yok/x/state.json";

  test("SC14 — Claude's tool shapes map to the guard and deny in Claude's format", async () => {
    const inputs = [
      stdin("Write", { file_path: TARGET }),
      stdin("Edit", { file_path: TARGET }),
      stdin("MultiEdit", { file_path: TARGET }),
      stdin("NotebookEdit", { notebook_path: TARGET }),
      stdin("Bash", { command: `rm ${TARGET}` }),
    ];
    for (const input of inputs) {
      const out = (await claudePreToolUse?.(input, deps, recordGuard)) ?? "";
      expect(out.endsWith("\n")).toBe(true);
      expect(JSON.parse(out)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("yok orchestrate next --run x"),
        },
      });
    }
    const read = stdin("Read", { file_path: TARGET });
    expect(await claudePreToolUse?.(read, deps, recordGuard)).toBe("");
    expect(await claudePreToolUse?.("not json", deps, recordGuard)).toBe("");
    const missingTool = JSON.stringify({ session_id: "s1", tool_input: {} });
    expect(await claudePreToolUse?.(missingTool, deps, recordGuard)).toBe("");
  });

  test.each([
    ["with agent_id", true, { agent_id: "a1", agent_type: "Explore" }],
    ["without agent_id", false, {}],
  ] as const)("a Bash call %s parses as subagent %p", async (_label, subagent, extra) => {
    const seen: ToolUse[] = [];
    const spy: PreToolUseHandler = {
      name: "spy",
      run: async (use) => {
        seen.push(use);
        return { kind: "allow" };
      },
    };
    const input = JSON.stringify({ ...JSON.parse(stdin("Bash", { command: "ls" })), ...extra });

    expect(await claudePreToolUse?.(input, deps, spy)).toBe("");
    expect(seen).toEqual([expect.objectContaining({ toolName: "Bash", subagent })]);
  });

  test.each<[string, Record<string, unknown>, ToolCall]>([
    [
      "two questions with a header and options",
      {
        questions: [
          {
            question: "Ship it?",
            header: "Release",
            options: [
              { label: "Yes", description: "Open the PR" },
              { label: "No", description: "Keep working" },
            ],
            multiSelect: false,
          },
          { question: "Anything else?", options: [{ label: "No" }], multiSelect: false },
        ],
      },
      {
        kind: "question",
        questions: [
          { question: "Ship it?", header: "Release", options: ["Yes", "No"] },
          { question: "Anything else?", options: ["No"] },
        ],
      },
    ],
    ["no questions", { questions: [] }, { kind: "other" }],
  ])(
    "SC301: Claude's AskUserQuestion with %s parses into its call, with the tool_use_id",
    async (_label, toolInput, call) => {
      const seen: ToolUse[] = [];
      const spy: PreToolUseHandler = {
        name: "spy",
        run: async (use) => {
          seen.push(use);
          return { kind: "allow" };
        },
      };
      const input = JSON.stringify({
        session_id: "s1",
        tool_name: "AskUserQuestion",
        tool_input: toolInput,
        tool_use_id: "toolu_1",
        cwd: "/repo",
      });

      expect(await claudePreToolUse?.(input, deps, spy)).toBe("");
      expect(seen).toEqual([
        expect.objectContaining({ agent: "claude", sessionId: "s1", toolUseId: "toolu_1", call }),
      ]);
    },
  );
});

describe("claudeAdapter.postToolUse", () => {
  const deps = { registry: NO_RUNS, env: {}, log: noopLogger };
  const ask = (toolInput: Record<string, unknown>, toolResponse: Record<string, unknown> = {}) => ({
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_2",
    tool_input: toolInput,
    tool_response: toolResponse,
  });
  const twoQuestions = [
    { question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] },
    { question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
  ];

  test.each<[string, unknown, PostToolUseInput]>([
    [
      "the fixture",
      CLAUDE_POST_TOOL_USE_ASK,
      {
        agent: "claude",
        sessionId: "8f1c2b7e-3d4a-4c9b-9e21-5a6f7d8c9b10",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_01AbCdEfGhIjKlMnOpQrStUv",
        result: {
          kind: "answers",
          answers: [
            {
              question: "How should hooks run after a run event is saved?",
              answer: "Detached helper (Recommended)",
            },
            {
              question: "Which moments should the built-in Slack notifier post?",
              answer:
                "Can you compare to current v1 implementation. My sense is every node start/end, ask question, rate limit",
            },
          ],
        },
      },
    ],
    [
      "two questions and an answer only to the first",
      ask({ questions: twoQuestions, answers: { "Ship it?": "No" } }),
      {
        agent: "claude",
        sessionId: "s1",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_2",
        result: { kind: "answers", answers: [{ question: "Ship it?", answer: "No" }] },
      },
    ],
    [
      "answers only in tool_response",
      ask({ questions: twoQuestions }, { questions: twoQuestions, answers: { "Ship it?": "Yes" } }),
      {
        agent: "claude",
        sessionId: "s1",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_2",
        result: { kind: "answers", answers: [{ question: "Ship it?", answer: "Yes" }] },
      },
    ],
    [
      "a rejected question, whose tool_response is the string Claude writes",
      { ...ask({ questions: twoQuestions }), tool_response: "User rejected tool use" },
      {
        agent: "claude",
        sessionId: "s1",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_2",
        result: { kind: "other" },
      },
    ],
    [
      'a multi-select answer ["A", "B"], joined as "A, B"',
      ask({ questions: twoQuestions }, { answers: { "Ship it?": ["A", "B"] } }),
      {
        agent: "claude",
        sessionId: "s1",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_2",
        result: { kind: "answers", answers: [{ question: "Ship it?", answer: "A, B" }] },
      },
    ],
    [
      "annotations carrying notes on one answer and a preview on another",
      ask(
        { questions: twoQuestions },
        {
          answers: { "Ship it?": "Yes", "Which database?": "SQLite" },
          annotations: {
            "Ship it?": { notes: "after the demo" },
            "Which database?": { preview: "one file", notes: "" },
          },
        },
      ),
      {
        agent: "claude",
        sessionId: "s1",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_2",
        result: {
          kind: "answers",
          answers: [
            { question: "Ship it?", answer: "Yes", notes: "after the demo" },
            { question: "Which database?", answer: "SQLite" },
          ],
        },
      },
    ],
    [
      "a Bash call",
      { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } },
      { agent: "claude", sessionId: "s1", toolName: "Bash", result: { kind: "other" } },
    ],
  ])(
    "SC307: Claude's PostToolUse for %s parses into what the handler sees, and prints nothing",
    async (_label, payload, expected) => {
      const seen: PostToolUseInput[] = [];
      const spy: PostToolUseHandler = { name: "spy", run: async (input) => void seen.push(input) };

      expect(await claudeAdapter.postToolUse?.(JSON.stringify(payload), deps, spy)).toBe("");
      expect(seen).toEqual([expected]);
    },
  );
});

describe("claudeAdapter.stopFailure", () => {
  const deps = { registry: NO_RUNS, env: {}, log: noopLogger };
  test.each([
    ["rate_limit", true],
    ["overloaded", false],
  ])(
    "Claude's error %s and its last_assistant_message reach the handler with usageLimit %p, and the hook prints nothing",
    async (error, usageLimit) => {
      const seen: StopFailureInput[] = [];
      const handler = {
        name: "spy",
        run: async (input: StopFailureInput) => void seen.push(input),
      };
      const stdin = line({
        session_id: "s1",
        hook_event_name: "StopFailure",
        error,
        error_details: "429",
        last_assistant_message: "You've hit your limit · resets 3pm (UTC)",
      });
      const printed = await claudeAdapter.stopFailure?.(stdin, deps, handler);
      expect(printed).toBe("");
      expect(seen).toEqual([
        {
          agent: "claude",
          sessionId: "s1",
          error,
          usageLimit,
          message: "You've hit your limit · resets 3pm (UTC)",
        },
      ]);
    },
  );
});

describe("claudeSettings handlers", () => {
  const settings = claudeSettings(["bun", "orchestrate.ts"]);
  const handlerNames = (groups: readonly { hooks: readonly { command: string }[] }[]): string[] =>
    groups.flatMap((group) =>
      group.hooks.map((hook) => /'--handler' '([^']+)'/.exec(hook.command)?.[1] ?? ""),
    );

  test("SC2: Claude registers only handlers that orchestrate hook knows", () => {
    const stop = handlerNames(settings.hooks.Stop);
    const preToolUse = handlerNames(settings.hooks.PreToolUse);
    for (const name of stop) expect(Object.keys(stopHandlers)).toContain(name);
    for (const name of preToolUse) expect(Object.keys(preToolUseHandlers)).toContain(name);
    expect([...stop, ...preToolUse]).toEqual(
      expect.arrayContaining([
        "continue-workflow",
        "record-guard",
        "record-resumed",
        "bash-antipatterns",
      ]),
    );
  });
});

// A registry run r-1 named feat-x in a temp repo, owned by Claude session s-1. Given POLICIES, it
// also has a state.json saved with them and its node design open.
const linkedRun = async (policies?: SavedPolicies) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "claude-hooks-home-")));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "claude-hooks-repo-")));
  const registry = createRegistry(registryPath(home));
  await registry.addRun({
    id: "r-1",
    workflow: "feature",
    workflowPath: join(cwd, "workflow.yaml"),
    inputs: {},
    cwd,
    sessions: [{ agent: "claude", sessionId: "s-1" }],
    name: "feat-x",
    terminal: null,
    config: null,
    tiers: null,
    createdAt: "2026-10-02T10:00:00Z",
  });
  const runDir = runDirOf(cwd, "feat-x");
  await mkdir(runDir, { recursive: true });
  if (policies !== undefined) {
    await writeFile(join(runDir, "state.json"), JSON.stringify(runningState(cwd, policies)));
  }
  const deps = { registry, env: { YOK_RUN_ID: "r-1" }, log: noopLogger };
  return { deps, events: () => jsonlEventStore(runDir).read() };
};

const runningState = (cwd: string, policies: SavedPolicies): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "feat-x",
  runDir: runDirOf(cwd, "feat-x"),
  version: "2.0.0",
  workflow: { name: "feature", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: "2026-10-02T10:00:00Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: cwd,
    repositories: { app: { path: cwd, git: { branch: "b", baseBranch: "main", startSha: "a" } } },
  },
  nodeRuns: {
    design: {
      nodeRunId: "design-1",
      nodeType: "agent",
      status: "running",
      startedAt: "2026-10-02T10:00:00Z",
      completedAt: null,
      artifacts: [],
    },
  },
  activeSessions: [],
  tiers: null,
  eventHandlers: {},
  subscribers: {},
  policies,
});

describe("Claude's question hooks in a run", () => {
  const QUESTION = {
    question: "Ship it?",
    header: "Release",
    options: [{ label: "Yes" }, { label: "No" }],
  };
  const askCall = (sessionId: string) =>
    line({
      session_id: sessionId,
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_1",
      tool_input: { questions: [QUESTION] },
      cwd: "/repo",
    });
  const answerCall = (sessionId: string) =>
    line({
      session_id: sessionId,
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_1",
      tool_input: { questions: [QUESTION] },
      tool_response: { questions: [QUESTION], answers: { "Ship it?": "Yes" }, annotations: {} },
    });

  test("SC304: a question and its answer from session s-1 are recorded in order, linked by toolu_1", async () => {
    const { deps, events } = await linkedRun();

    expect(await claudeAdapter.preToolUse?.(askCall("s-1"), deps, questionNotice)).toBe("");
    expect(await claudeAdapter.postToolUse?.(answerCall("s-1"), deps, answerNotice)).toBe("");

    const stored = await events();
    expect(stored.map((event) => [event.type, event.payload])).toEqual([
      [
        "agent.question.asked",
        {
          agent: "claude",
          sessionId: "s-1",
          toolUseId: "toolu_1",
          questions: [{ question: "Ship it?", header: "Release", options: ["Yes", "No"] }],
        },
      ],
      [
        "agent.question.answered",
        {
          agent: "claude",
          sessionId: "s-1",
          toolUseId: "toolu_1",
          answers: [{ question: "Ship it?", answer: "Yes" }],
        },
      ],
    ]);
  });

  test("SC305: a question and answer from session s-9, which no run owns, are allowed and record nothing", async () => {
    const { deps, events } = await linkedRun();

    expect(await claudeAdapter.preToolUse?.(askCall("s-9"), deps, questionNotice)).toBe("");
    expect(await claudeAdapter.postToolUse?.(answerCall("s-9"), deps, answerNotice)).toBe("");

    expect(await events()).toEqual([]);
  });
});

describe("Claude's question refused in a run with interaction off", () => {
  test("SC523: the AskUserQuestion hook command prints a deny whose reason is the policy's message", async () => {
    const policies: SavedPolicies = {
      values: { interaction: false },
      sources: { interaction: "workflow" },
    };
    const { deps } = await linkedRun(policies);
    const stdin = line({
      session_id: "s-1",
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_1",
      tool_input: { questions: [{ question: "Ship it?", options: [{ label: "Yes" }] }] },
      cwd: "/repo",
    });

    const out = (await claudeAdapter.preToolUse?.(stdin, deps, questionGuard)) ?? "";

    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(
          /^No one will answer in this run\..*`yok orchestrate done design-1 --run feat-x --error -`/,
        ),
      },
    });
  });
});

describe("Claude's StopFailure in a run", () => {
  const stopFailure = (error: string, message: string) =>
    line({
      session_id: "s-1",
      hook_event_name: "StopFailure",
      error,
      last_assistant_message: message,
    });

  test.each([
    [
      "authentication_failed records agent.stopped with its message, and no limit",
      "authentication_failed",
      "Invalid API key",
      [
        [
          "agent.stopped",
          {
            agent: "claude",
            sessionId: "s-1",
            error: "authentication_failed",
            message: "Invalid API key",
          },
        ],
      ],
    ],
    [
      "rate_limit is a usage limit, so record-agent-error records nothing",
      "rate_limit",
      "You've hit your limit · resets 3pm (UTC)",
      [],
    ],
  ])("SC306: %s", async (_label, error, message, expected) => {
    const { deps, events } = await linkedRun();

    await claudeAdapter.stopFailure?.(stopFailure(error, message), deps, recordAgentError);

    expect((await events()).map((event) => [event.type, event.payload])).toEqual(expected);
  });
});
