import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type RunRef, runDirOf } from "@yok/sdk";
import { readClaudeScreen } from "./agents/claude.ts";
import { renderStatusline } from "./statusline.ts";

const plain = (line: string): string => stripVTControlCharacters(line);
const SPINNER_START = /^[·✢✳✶✻✽*]/;
const FORBIDDEN = ["…", "queued messages", "limit", "enter to confirm", "esc to cancel"];

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const SECOND = 1000;
const MINUTE = 60 * SECOND;

const node = (status: string, extra: Record<string, unknown> = {}) => ({
  nodeRunId: "nr-1",
  nodeType: "agent",
  status,
  startedAt: ago(45 * SECOND),
  completedAt: status === "running" ? null : ago(SECOND),
  artifacts: [],
  ...extra,
});

const agentYaml = (id: string, indent: number, stage?: string): string => {
  const pad = " ".repeat(indent);
  const body = stage === undefined ? "prompt: do it" : `stage: ${stage}`;
  return `${pad}- id: ${id}\n${pad}  type: agent\n${pad}  input: {}\n${pad}  ${body}\n`;
};

type Fixture = Readonly<{
  status?: string;
  blocker?: Record<string, unknown>;
  nodeRuns?: Record<string, unknown>;
  workflow?: string | null;
  state?: string;
}>;

const makeRun = ({
  status = "running",
  blocker,
  nodeRuns = {},
  workflow = `name: w\nnodes:\n${["a", "b", "c", "d"].map((id) => agentYaml(id, 2)).join("")}`,
  state,
}: Fixture = {}): RunRef => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "statusline-")));
  const dir = runDirOf(cwd, "feat-x");
  mkdirSync(dir, { recursive: true });
  const body = {
    schemaVersion: 1,
    lastEventSeq: 1,
    runId: "r-1",
    runName: "feat-x",
    runDir: dir,
    version: "0.0.0",
    workflow: { name: "w", path: "workflow.yaml" },
    input: {},
    scope: null,
    startedAt: ago(10 * MINUTE),
    completedAt: null,
    status,
    ...(blocker === undefined ? {} : { blocker }),
    workspace: {
      type: "mono",
      path: cwd,
      repositories: {
        repo: { path: cwd, git: { branch: "main", baseBranch: "main", startSha: "abc" } },
      },
    },
    nodeRuns,
    activeSessions: [],
    tiers: null,
    eventHandlers: {},
  };
  writeFileSync(join(dir, "state.json"), state ?? JSON.stringify(body));
  if (workflow !== null) writeFileSync(join(dir, "workflow.yaml"), workflow);
  return { id: "r-1", cwd, name: "feat-x" };
};

const lineOf = async (run: RunRef | undefined, stdin = "{}"): Promise<string> =>
  plain(await renderStatusline(stdin, run));

describe("renderStatusline", () => {
  test("SC1: a running top-level node shows the run, node, bar and count", async () => {
    const run = makeRun({ nodeRuns: { a: node("completed"), design: node("running") } });
    expect(await lineOf(run)).toBe("yok feat-x ▸ design [▓▓▓░░░░░░░] 1/4 · 45s");
  });

  test("shows (stage S) only when the stage differs from the node id", async () => {
    const workflow = `name: w\nnodes:\n${agentYaml("design", 2, "design")}${agentYaml("plan", 2, "planning")}`;
    const same = makeRun({ nodeRuns: { design: node("running") }, workflow });
    const differs = makeRun({ nodeRuns: { plan: node("running") }, workflow });
    expect(await lineOf(same)).toStartWith("yok feat-x ▸ design [");
    expect(await lineOf(differs)).toStartWith("yok feat-x ▸ plan (stage planning) [");
  });

  test("SC2: walks nested nodes to the deepest running node and shows the loop pass", async () => {
    const workflow = `name: w\nnodes:\n  - id: build\n    type: loop\n    until: "{{ false }}"\n    maxIterations: 5\n    input: {}\n    nodes:\n${agentYaml("code", 6, "coder")}`;
    const nodeRuns = {
      build: node("running", {
        nodeType: "loop",
        iteration: 2,
        nodes: { code: node("running") },
      }),
    };
    expect(await lineOf(makeRun({ nodeRuns, workflow }))).toStartWith(
      "yok feat-x ▸ build #2 › code (stage coder) [░░░░░░░░░░] 0/1",
    );
    const loopOnly = { build: node("running", { nodeType: "loop", iteration: 3 }) };
    expect(await lineOf(makeRun({ nodeRuns: loopOnly, workflow }))).toStartWith(
      "yok feat-x ▸ build #3 [",
    );
  });

  test("a stage node inside a switch case or its default keeps its stage label", async () => {
    const workflow = `name: w\nnodes:\n  - id: pick\n    type: switch\n    expression: "{{ inputs.kind }}"\n    input: {}\n    cases:\n      - id: big\n        value: big\n        nodes:\n${agentYaml("plan", 10, "planning")}    default:\n${agentYaml("fix", 6, "implement")}`;
    const inCase = {
      pick: node("running", { nodeType: "switch", nodes: { plan: node("running") } }),
    };
    const inDefault = {
      pick: node("running", { nodeType: "switch", nodes: { fix: node("running") } }),
    };
    expect(await lineOf(makeRun({ nodeRuns: inCase, workflow }))).toStartWith(
      "yok feat-x ▸ pick › plan (stage planning) [",
    );
    expect(await lineOf(makeRun({ nodeRuns: inDefault, workflow }))).toStartWith(
      "yok feat-x ▸ pick › fix (stage implement) [",
    );
  });

  test("SC3: a finished run shows its outcome with no node or elapsed time", async () => {
    const done = {
      a: node("completed"),
      b: node("completed"),
      c: node("completed"),
      d: node("completed"),
    };
    expect(await lineOf(makeRun({ status: "completed", nodeRuns: done }))).toBe(
      "yok feat-x ▸ ✓ completed [▓▓▓▓▓▓▓▓▓▓] 4/4",
    );
    expect(await lineOf(makeRun({ status: "failed", nodeRuns: { a: node("completed") } }))).toBe(
      "yok feat-x ▸ ✗ failed [▓▓▓░░░░░░░] 1/4",
    );
    expect(await lineOf(makeRun({ status: "cancelled" }))).toStartWith("yok feat-x ▸ ✗ cancelled");
  });

  test.each([
    [45 * SECOND, "45s"],
    [59 * SECOND, "59s"],
    [60 * SECOND, "1m"],
    [12 * MINUTE, "12m"],
    [59 * MINUTE, "59m"],
    [60 * MINUTE, "1h00m"],
    [65 * MINUTE, "1h05m"],
  ])("SC4: a node running for %pms shows an elapsed time of %s", async (ms, elapsed) => {
    const run = makeRun({ nodeRuns: { a: node("running", { startedAt: ago(ms) }) } });
    expect(await lineOf(run)).toEndWith(` · ${elapsed}`);
  });

  test("a running run between nodes shows the bar without a node or elapsed time", async () => {
    const between = makeRun({ nodeRuns: { a: node("completed") } });
    expect(await lineOf(between)).toBe("yok feat-x [▓▓▓░░░░░░░] 1/4");
  });

  test("SC5: model and context use appear when present and are left out otherwise", async () => {
    const run = makeRun({ nodeRuns: { a: node("running") } });
    const full = JSON.stringify({
      model: { display_name: "Opus" },
      context_window: { used_percentage: 41.6 },
    });
    expect(await lineOf(run, full)).toEndWith(" · 45s · Opus · ctx 42%");
    const nulls = JSON.stringify({ model: {}, context_window: { used_percentage: null } });
    expect(await lineOf(run, nulls)).toEndWith(" · 45s");
    expect(await lineOf(run, "not json")).toEndWith(" · 45s");
    expect(await lineOf(run, "")).toEndWith(" · 45s");
  });

  test("SC6: falls back without a run, without a readable state, and without a workflow file", async () => {
    expect(await lineOf(undefined)).toBe("yok · starting");
    expect(await lineOf(makeRun({ state: "{ not json" }))).toBe("yok feat-x");
    const noWorkflow = makeRun({ nodeRuns: { a: node("running") }, workflow: null });
    expect(await lineOf(noWorkflow)).toBe("yok feat-x ▸ a · 45s");
  });

  test("SC7: fixed text never trips yok's screen checks", async () => {
    const lines = [
      await lineOf(undefined),
      await lineOf(makeRun({ state: "{" })),
      await lineOf(
        makeRun({ nodeRuns: { a: node("running") } }),
        '{"model":{"display_name":"Opus"}}',
      ),
      await lineOf(makeRun({ status: "completed" })),
      await lineOf(makeRun({ status: "failed" })),
      await lineOf(makeRun({ status: "cancelled" })),
    ];
    for (const line of lines) {
      expect(line).toStartWith("yok");
      expect(SPINNER_START.test(line)).toBe(false);
      for (const word of FORBIDDEN) expect(line).not.toContain(word);
      expect(readClaudeScreen(line).kind).not.toBe("busy");
    }
  });

  test.each([
    ["question", { questions: [{ question: "Ship?", options: [] }] }, "needs your answer"],
    ["usage-limit", { resumeAt: new Date(2026, 8, 26, 14, 0).toISOString() }, "paused until 14:00"],
    ["stuck", { message: null }, "stuck"],
    ["agent-error", { error: "authentication_failed", message: null }, "agent error"],
  ])(
    "SC135: a run blocked on %s shows ⏸ and its phrase and keeps its elapsed time",
    async (reason, details, phrase) => {
      const blocker = { reason, node: "design", since: ago(MINUTE), details };
      const run = makeRun({ status: "blocked", blocker, nodeRuns: { design: node("running") } });
      const line = await lineOf(run);
      expect(line).toContain(`▸ ⏸ ${phrase}`);
      expect(line).toEndWith(" · 45s");
      expect(SPINNER_START.test(line)).toBe(false);
      for (const word of FORBIDDEN) expect(line).not.toContain(word);
    },
  );
});
