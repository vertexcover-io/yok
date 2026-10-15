import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGit,
  noopLogger,
  type RegistryReader,
  readState,
  runDirOf,
  type SavedPolicies,
} from "@yok/sdk";
import { createRegistry, jsonlEventStore } from "@yok/sdk/internal";
import { questionGuard, recordGuard } from "../hooks/pre-tool-use.ts";
import { continueWorkflow } from "../hooks/stop.ts";
import { initializeRun, nextStep } from "../runs.ts";
import { claudeAdapter } from "./claude-hooks.ts";
import { codexAdapter, readCodexTranscript } from "./codex-hooks.ts";

const NO_RUNS: RegistryReader = {
  findRun: async () => undefined,
  findRunsByName: async () => [],
  listRuns: async () => [],
};
const deps = { registry: NO_RUNS, env: { YOK_RUN_ID: "r-1" }, log: noopLogger };

const line = (type: string, payload: unknown): string =>
  JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type, payload });

const INTERACTION_OFF: SavedPolicies = {
  values: { interaction: false },
  sources: { interaction: "cli" },
};
const NO_SWITCHES = new Set<never>();

// Run feat-x of a one-agent-node workflow in a fresh git repo, owned by AGENT's session s1, saved
// with POLICIES, and with its node `ask` open.
const openAgentRun = async (policies?: SavedPolicies, agent: "codex" | "claude" = "codex") => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "codex-run-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const workflowPath = join(cwd, "ask.yaml");
  await writeFile(
    workflowPath,
    "name: ask\nnodes:\n  - { id: ask, type: agent, prompt: hi, input: {} }\n",
  );
  const registry = createRegistry(
    join(await mkdtemp(join(tmpdir(), "codex-home-")), "registry.json"),
  );
  await registry.addRun({
    id: "r-1",
    workflow: "ask",
    workflowPath,
    inputs: {},
    cwd,
    sessions: [{ agent, sessionId: "s1" }],
    name: null,
    terminal: null,
    config: null,
    tiers: null,
    createdAt: "2026-10-15T10:00:00Z",
    ...(policies === undefined ? {} : { policies }),
  });
  const init = await initializeRun({
    registry,
    runId: "r-1",
    name: "feat-x",
    git: createGit(),
    log: noopLogger,
    modelSwitchAgents: NO_SWITCHES,
  });
  if (!init.ok) throw new Error(init.error);
  const run = { id: "r-1", cwd, name: "feat-x" };
  const opened = await nextStep(run, NO_SWITCHES);
  if (!opened.ok) throw new Error(opened.error);
  const runDir = runDirOf(cwd, "feat-x");
  const deps = { registry, env: { YOK_RUN_ID: "r-1" }, log: noopLogger };
  const events = () => jsonlEventStore(runDir).read();
  return { run, runDir, deps, events };
};

describe("codexAdapter.stop", () => {
  test("SC9: unreadable input lets the turn end", async () => {
    expect(await codexAdapter.stop?.("not json", deps, continueWorkflow)).toBe("");
    expect(await codexAdapter.stop?.("{}", deps, continueWorkflow)).toBe("");
  });

  test("SC9: a continue reply is Codex's block JSON, an allow prints nothing", async () => {
    const stdin = JSON.stringify({
      session_id: "s1",
      transcript_path: null,
      stop_hook_active: false,
    });
    const seen: unknown[] = [];
    const handler = (kind: "continue" | "allow") => ({
      name: "t",
      run: async (input: { agent: string; sessionId: string }) => {
        seen.push([input.agent, input.sessionId]);
        return kind === "continue" ? { kind, message: "keep going" } : { kind };
      },
    });

    const blocked = await codexAdapter.stop?.(stdin, deps, handler("continue"));
    const allowed = await codexAdapter.stop?.(stdin, deps, handler("allow"));

    expect(JSON.parse(blocked ?? "")).toEqual({ decision: "block", reason: "keep going" });
    expect(allowed).toBe("");
    expect(seen[0]).toEqual(["codex", "s1"]);
  });
});

describe("an agent that keeps stopping with its node open", () => {
  const stop = JSON.stringify({
    session_id: "s1",
    transcript_path: null,
    stop_hook_active: false,
    last_assistant_message: "Which database should this use?",
  });
  const claudeStop = JSON.stringify({
    session_id: "s1",
    last_assistant_message: "Which database should this use?",
  });
  const stopTwice = async (deps: Parameters<NonNullable<typeof codexAdapter.stop>>[1]) => [
    await codexAdapter.stop?.(stop, deps, continueWorkflow),
    await codexAdapter.stop?.(stop, deps, continueWorkflow),
  ];

  test.each([
    ["codex", codexAdapter, stop],
    ["claude", claudeAdapter, claudeStop],
  ] as const)(
    "SC525: with interaction off, a %s agent's first stop is sent back with the policy's message, the second with next, and the node fails as needs-input with the agent's question",
    async (agent, adapter, stdin) => {
      const { run, runDir, deps, events } = await openAgentRun(INTERACTION_OFF, agent);

      const first = await adapter.stop?.(stdin, deps, continueWorkflow);
      const second = await adapter.stop?.(stdin, deps, continueWorkflow);

      expect(JSON.parse(first ?? "")).toEqual({
        decision: "block",
        reason: expect.stringContaining("No one will answer in this run."),
      });
      expect(JSON.parse(second ?? "")).toEqual({
        decision: "block",
        reason: expect.stringContaining("yok orchestrate next --run feat-x"),
      });
      const ask = (await readState(runDir))?.nodeRuns.ask;
      expect(ask?.status).toBe("failed");
      expect(ask?.output).toEqual({
        kind: "needs-input",
        message: expect.stringContaining("Which database should this use?"),
      });
      const stored = await events();
      expect(stored.filter((e) => e.type === "policy.applied").map((e) => e.payload)).toEqual([
        { policy: "interaction", effect: "unanswered-stop", nodeId: "ask" },
      ]);
      expect(stored.map((event) => event.type)).not.toContain("agent.stuck");
      expect(await nextStep(run, NO_SWITCHES)).toEqual({
        ok: true,
        value: { kind: "finished", status: "failed" },
      });
    },
  );

  test("SC526 (regression): with no saved policies, the second stop goes through as max-blocks-reached, records agent.stuck and leaves the node open", async () => {
    const { runDir, deps, events } = await openAgentRun();

    const [first, second] = await stopTwice(deps);

    expect(JSON.parse(first ?? "")).toMatchObject({ decision: "block" });
    expect(second).toBe("");
    const stored = await events();
    expect(
      stored.filter((e) => e.type === "hooks.stop.called").map((e) => e.payload),
    ).toMatchObject([{ reason: "node-not-done" }, { reason: "max-blocks-reached" }]);
    expect(stored.map((event) => event.type)).toContain("agent.stuck");
    expect((await readState(runDir))?.nodeRuns.ask?.status).toBe("running");
  });
});

describe("codexAdapter.preToolUse", () => {
  const stdin = (tool_name: string, tool_input: Record<string, unknown>) =>
    JSON.stringify({ session_id: "s1", tool_name, tool_input, cwd: "/repo" });
  const TARGET = ".yok/x/state.json";

  test("SC10: a shell write to state.json and an apply_patch on event.jsonl are denied in Codex's format", async () => {
    const patch = `*** Begin Patch\n*** Add File: notes.md\n+hi\n*** Update File: .yok/x/event.jsonl\n@@\n+x\n*** End Patch`;
    for (const input of [
      stdin("Bash", { command: `rm ${TARGET}` }),
      stdin("exec_command", { command: `mv a ${TARGET}` }),
      stdin("exec_command", { cmd: `mv a ${TARGET}` }),
      stdin("local_shell", { command: `rm ${TARGET}` }),
      stdin("shell", { command: ["bash", "-lc", `rm ${TARGET}`] }),
      stdin("apply_patch", { command: patch }),
    ]) {
      const out = (await codexAdapter.preToolUse?.(input, deps, recordGuard)) ?? "";
      expect(JSON.parse(out)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("orchestrate next --run x"),
        },
      });
    }
  });

  test("SC524: request_user_input is denied with the policy's message on a run with interaction off, and allowed on one with interaction on", async () => {
    const ask = JSON.stringify({
      session_id: "s1",
      tool_name: "request_user_input",
      tool_input: {
        questions: [
          {
            id: "db",
            header: "Database",
            question: "Which database should this use?",
            options: [{ label: "Postgres", description: "the usual" }],
          },
        ],
      },
      cwd: "/repo",
    });
    const off = await openAgentRun(INTERACTION_OFF);
    const on = await openAgentRun();

    const refused = (await codexAdapter.preToolUse?.(ask, off.deps, questionGuard)) ?? "";
    const allowed = await codexAdapter.preToolUse?.(ask, on.deps, questionGuard);

    expect(JSON.parse(refused)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/^No one will answer in this run\./),
      },
    });
    expect(allowed).toBe("");
  });

  test("request_user_input is refused on a run with interaction off even when its input is not shaped like Claude's question", async () => {
    const ask = JSON.stringify({
      session_id: "s1",
      tool_name: "request_user_input",
      tool_input: { questions: [{ id: "db", question: "Which database?", options: null }] },
      cwd: "/repo",
    });
    const off = await openAgentRun(INTERACTION_OFF);

    const refused = (await codexAdapter.preToolUse?.(ask, off.deps, questionGuard)) ?? "";

    expect(JSON.parse(refused || "{}")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  test("SC10: other tools, harmless commands and unreadable input pass silently", async () => {
    const allowed = [
      stdin("Read", { command: TARGET }),
      stdin("shell", { command: "echo hi" }),
      stdin("apply_patch", { command: "*** Begin Patch\n*** Add File: a.md\n+x\n*** End Patch" }),
      "not json",
    ];
    for (const input of allowed) {
      expect(await codexAdapter.preToolUse?.(input, deps, recordGuard)).toBe("");
    }
  });
});

describe("readCodexTranscript", () => {
  test("SC11: prompts and shell commands come out of a rollout, from every shell shape", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "codex-rollout-")), "rollout.jsonl");
    const lines = [
      line("session_meta", { id: "s1" }),
      line("event_msg", { type: "user_message", message: "go" }),
      line("event_msg", { type: "agent_message", message: "thinking" }),
      line("response_item", {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "yok orchestrate next --run x" }),
      }),
      line("response_item", {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["bash", "-lc", "ls -la"] }),
      }),
      line("response_item", {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["git", "status"] }),
      }),
      line("response_item", {
        type: "custom_tool_call",
        name: "exec",
        input: 'const r = await tools.exec_command({cmd: "echo \\"hi\\"", yield_time_ms: 1});',
      }),
      line("response_item", { type: "function_call", name: "update_plan", arguments: "{}" }),
      "{not json",
      line("event_msg", { type: "user_message", message: "why?" }),
    ];
    await writeFile(path, lines.join("\n"));

    expect(await readCodexTranscript(path)).toEqual([
      { kind: "prompt", text: "go" },
      { kind: "command", command: "yok orchestrate next --run x" },
      { kind: "command", command: "ls -la" },
      { kind: "command", command: "git status" },
      { kind: "command", command: 'echo "hi"' },
      { kind: "prompt", text: "why?" },
    ]);
  });

  test("SC11: no path, or a missing file, is unknown", async () => {
    expect(await readCodexTranscript(undefined)).toBeUndefined();
    expect(await readCodexTranscript(join(tmpdir(), "no-such-rollout.jsonl"))).toBeUndefined();
  });
});
