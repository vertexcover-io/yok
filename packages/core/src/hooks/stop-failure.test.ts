import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@yok/sdk";
import {
  noopLogger,
  registryPath,
  runDirOf,
  type StopFailureInput,
  type TranscriptEntry,
} from "@yok/sdk";
import { createRegistry, jsonlEventStore } from "@yok/sdk/internal";
import { orchestrateArgv } from "../stage.ts";
import { recordAgentError, resumeAfterLimit } from "./stop-failure.ts";

const setUp = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hooks-home-")));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "hooks-repo-")));
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
  const deps = { registry, env: { YOK_RUN_ID: "r-1" }, log: noopLogger };
  return { runDir, cwd, deps };
};

const failure = (error: string, sessionId = "s1"): StopFailureInput => ({
  agent: "claude",
  sessionId,
  error,
  usageLimit: error === "rate_limit",
  retryable: error === "server_error" || error === "unknown",
  message: "You've hit your limit · resets 3pm (Asia/Kolkata)",
  readTranscript: async () => undefined,
});

// The wait is a detached orchestrate process, so the spawn is the boundary these tests stop at.
let spawn: ReturnType<typeof spyOn<typeof sdk, "spawnDetached">>;
beforeAll(() => {
  spawn = spyOn(sdk, "spawnDetached");
});
beforeEach(() => spawn.mockImplementation(() => 0));
afterEach(() => spawn.mockReset());
afterAll(() => spawn.mockRestore());

describe("resumeAfterLimit", () => {
  test("SC22: a usage limit in a run session is logged as agent.limit.reached and starts the program's orchestrate auto-resume for that event", async () => {
    const { runDir, cwd, deps } = await setUp();
    await resumeAfterLimit.run(failure("rate_limit"), deps);
    const [event] = await jsonlEventStore(runDir).read();
    expect(event).toMatchObject({
      type: "agent.limit.reached",
      payload: {
        agent: "claude",
        sessionId: "s1",
        error: "rate_limit",
        message: "You've hit your limit · resets 3pm (Asia/Kolkata)",
      },
    });
    const id = event?.id ?? "";
    const [program, ...self] = orchestrateArgv();
    expect(spawn.mock.calls).toEqual([
      [
        program,
        [...self, "auto-resume", id, "--run-id", "r-1", "--session-id", "s1"],
        { cwd, output: "ignore" },
      ],
    ]);
  });

  test("the agent's usageLimit flag, not its error name, starts the wait", async () => {
    const { deps } = await setUp();
    await resumeAfterLimit.run({ ...failure("usage_limit_reached"), usageLimit: true }, deps);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["an error that is not a usage limit, such as overloaded", failure("overloaded")],
    ["a session not linked to the run", failure("rate_limit", "other")],
  ])("%s logs nothing and starts no wait", async (_, input) => {
    const { runDir, deps } = await setUp();
    await resumeAfterLimit.run(input, deps);
    expect(await jsonlEventStore(runDir).read()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("recordAgentError", () => {
  test.each<[string, readonly TranscriptEntry[] | undefined, boolean]>([
    [
      "a tool called after the last message, such as yok's continue",
      [
        { kind: "prompt", text: "continue" },
        { kind: "command", command: "bun test" },
      ],
      true,
    ],
    [
      "tools called only before the last message",
      [
        { kind: "tool", name: "Edit" },
        { kind: "prompt", text: "continue" },
      ],
      false,
    ],
    ["no transcript to read", undefined, false],
  ])("an API error records progressed from its transcript: %s", async (_, entries, progressed) => {
    const { runDir, deps } = await setUp();
    await recordAgentError.run(
      { ...failure("server_error"), readTranscript: async () => entries },
      deps,
    );
    const [event] = await jsonlEventStore(runDir).read();
    expect(event).toMatchObject({ type: "agent.error.reached", payload: { progressed } });
  });

  test("SC2: a server_error in a run session, even one whose hook group lists only record-agent-error, is logged as agent.error.reached and starts the wait helper for that event", async () => {
    const { runDir, cwd, deps } = await setUp();
    await recordAgentError.run(failure("server_error"), deps);
    const events = await jsonlEventStore(runDir).read();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent.error.reached",
      payload: {
        agent: "claude",
        sessionId: "s1",
        error: "server_error",
        message: "You've hit your limit · resets 3pm (Asia/Kolkata)",
      },
    });
    const [program, ...self] = orchestrateArgv();
    expect(spawn.mock.calls).toEqual([
      [
        program,
        [...self, "auto-resume", events[0]?.id ?? "", "--run-id", "r-1", "--session-id", "s1"],
        { cwd, output: "ignore" },
      ],
    ]);
  });

  test("SC3: a usage limit records nothing, and authentication_failed records agent.stopped with no wait", async () => {
    const { runDir, deps } = await setUp();
    await recordAgentError.run(failure("rate_limit"), deps);
    expect(await jsonlEventStore(runDir).read()).toEqual([]);

    await recordAgentError.run(failure("authentication_failed"), deps);
    const events = await jsonlEventStore(runDir).read();
    expect(events.map((event) => event.type)).toEqual(["agent.stopped"]);
    expect(events[0]?.payload).toMatchObject({ error: "authentication_failed" });
    expect(spawn).not.toHaveBeenCalled();
  });
});
