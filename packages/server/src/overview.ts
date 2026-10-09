import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readWorkflowFile, sortTopologically, type Workflow, type WorkflowNode } from "@yok/core";
import type { Blocker, ITerminalHost, JsonValue, NodeRun, State, WorkflowRun } from "@yok/sdk";
import { runDirOf, SkipOutputSchema } from "@yok/sdk";
import { findRunningLeaf, isRunLive, type Registry } from "@yok/sdk/internal";
import * as z from "zod";
import { isAgentAlive, readStateOrNull } from "./delivery.ts";

export type RunStatus = State["status"] | "starting" | "gone" | "missing" | "unreadable";

export type RunSummary = Readonly<{
  id: string;
  name: string | null;
  workflow: string;
  folder: string;
  cwd: string;
  prompt: string | null;
  status: RunStatus;
  steps: Readonly<{ done: number; total: number | null }>;
  current: string | null;
  agent: string | null;
  tier: string | null;
  model: string | null;
  blocker: Blocker | null;
  startedAt: string;
  completedAt: string | null;
  pr: string | null;
}>;

export type RunFiles = Readonly<{
  state: State | null;
  workflow: Workflow | null;
  hasRunDir: boolean;
}>;

type NodeRuns = Readonly<Record<string, NodeRun>>;

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

const promptOf = (inputs: WorkflowRun["inputs"]): string | null => {
  const text = inputs.prompt ?? inputs.task;
  return typeof text === "string" ? text : null;
};

const outputsOf = (nodes: NodeRuns): readonly JsonValue[] =>
  Object.values(nodes).flatMap((run) => [
    ...(run.output === undefined ? [] : [run.output]),
    ...outputsOf(run.nodes ?? {}),
  ]);

// https only: the page links it, and z.url() lets a javascript: URL through. Outputs only: a node's
// input can quote another PR's URL, as a task text often does.
const findPr = (state: State): string | null => {
  const fromGit = Object.values(state.workspace.repositories)
    .map((repo) => repo.git.pr?.url)
    .find((url) => url?.startsWith("https://"));
  if (fromGit !== undefined) return fromGit;
  const found = outputsOf(state.nodeRuns)
    .map((output) => PR_URL.exec(JSON.stringify(output))?.[0])
    .find((url) => url !== undefined);
  return found ?? null;
};

// agentAlive is null when tmux was not asked, as for a run that is no longer live.
export const summarizeRun = (
  run: WorkflowRun,
  files: RunFiles,
  agentAlive: boolean | null,
): RunSummary => {
  const base = {
    id: run.id,
    name: run.name,
    workflow: run.workflow,
    folder: basename(run.cwd),
    cwd: run.cwd,
    prompt: promptOf(run.inputs),
    steps: { done: 0, total: files.workflow?.nodes.length ?? null },
    current: null,
    agent: null,
    tier: null,
    model: null,
    blocker: null,
    startedAt: run.createdAt,
    completedAt: null,
    pr: null,
  };
  if (run.name === null) return { ...base, status: "starting" };
  const { state } = files;
  if (state === null) return { ...base, status: files.hasRunDir ? "unreadable" : "missing" };
  const finished = Object.values(state.nodeRuns).filter((node) => node.status !== "running");
  const leaf = findRunningLeaf(state.nodeRuns);
  const status = isRunLive(state.status) && agentAlive === false ? "gone" : state.status;
  return {
    ...base,
    status,
    steps: { ...base.steps, done: finished.length },
    current: leaf?.path ?? null,
    agent: leaf?.run.agentState?.agent ?? null,
    tier: leaf?.run.agentState?.tier ?? null,
    model: leaf?.run.agentState?.model ?? null,
    blocker: status === "blocked" ? (state.blocker ?? null) : null,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    pr: findPr(state),
  };
};

// By run folder. init copies workflow.yaml once and nothing rewrites it, and a finished run's state
// never changes again, so the list reads neither twice.
const workflows = new Map<string, Workflow>();
const finishedRuns = new Map<string, RunFiles>();

const readWorkflowOnce = async (runDir: string): Promise<Workflow | null> => {
  const kept = workflows.get(runDir);
  if (kept !== undefined) return kept;
  const workflow = await readWorkflowFile(join(runDir, "workflow.yaml")).catch(() => null);
  if (workflow !== null) workflows.set(runDir, workflow);
  return workflow;
};

export const readRunFiles = async (run: WorkflowRun): Promise<RunFiles> => {
  if (run.name === null) return { state: null, workflow: null, hasRunDir: false };
  const runDir = runDirOf(run.cwd, run.name);
  const kept = finishedRuns.get(runDir);
  if (kept !== undefined) return kept;
  const [state, workflow, hasRunDir] = await Promise.all([
    readStateOrNull(runDir),
    readWorkflowOnce(runDir),
    stat(runDir).then(
      (found) => found.isDirectory(),
      () => false,
    ),
  ]);
  const files = { state, workflow, hasRunDir };
  if (state !== null && !isRunLive(state.status)) finishedRuns.set(runDir, files);
  return files;
};

// Only a live run asks tmux, so a long history costs no terminal calls.
const summarizeLive = async (run: WorkflowRun, host: ITerminalHost): Promise<RunSummary> => {
  const files = await readRunFiles(run);
  const live = files.state !== null && isRunLive(files.state.status);
  return summarizeRun(run, files, live ? await isAgentAlive(run, host) : null);
};

export const listRunSummaries = async (
  registry: Registry,
  host: ITerminalHost,
): Promise<readonly RunSummary[]> => {
  const runs = [...(await registry.listRuns())].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return Promise.all(runs.map((run) => summarizeLive(run, host)));
};

export type Step = Readonly<{
  id: string;
  path: string;
  type: string;
  stage: string | null;
  status: NodeRun["status"] | "pending";
  startedAt: string | null;
  completedAt: string | null;
  iteration: number | null;
  agent: string | null;
  tier: string | null;
  model: string | null;
  artifacts: readonly string[];
  reason: string | null;
  output: string | null;
  children: readonly Step[];
}>;

const OUTPUT_LIMIT = 4000;

const skipReason = (output: unknown): string | null => {
  const skip = SkipOutputSchema.safeParse(output);
  if (!skip.success) return null;
  if (skip.data.reason === "when-false")
    return `condition was false: ${skip.data.proof.expression}`;
  if (skip.data.reason === "dependency-skipped") {
    return `skipped because ${skip.data.proof.dependencies.join(", ")} were skipped`;
  }
  return "no case matched";
};

const reasonOf = (run: NodeRun | undefined): string | null => {
  if (run?.status === "skipped") return skipReason(run.output);
  if (run?.status !== "failed" && run?.status !== "cancelled") return null;
  const error = z.object({ message: z.string() }).safeParse(run.output);
  return error.success ? error.data.message : null;
};

// A step's output can be a whole PR body; the cut keeps the page light.
const outputOf = (run: NodeRun | undefined): string | null => {
  if (run?.status !== "completed" || run.output === undefined) return null;
  const text = typeof run.output === "string" ? run.output : JSON.stringify(run.output, null, 2);
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}…` : text;
};

type StepNode = Readonly<{ id: string; type: string; stage: string | null }>;

const toStep = (
  node: StepNode,
  path: readonly string[],
  run: NodeRun | undefined,
  children: readonly Step[],
): Step => ({
  ...node,
  path: path.join("."),
  status: run?.status ?? "pending",
  startedAt: run?.startedAt ?? null,
  completedAt: run?.completedAt ?? null,
  iteration: run?.iteration ?? null,
  agent: run?.agentState?.agent ?? null,
  tier: run?.agentState?.tier ?? null,
  model: run?.agentState?.model ?? null,
  artifacts: run?.artifacts.map((artifact) => artifact.path) ?? [],
  reason: reasonOf(run),
  output: outputOf(run),
  children,
});

const inRunOrder = (nodes: readonly WorkflowNode[]): readonly WorkflowNode[] => {
  try {
    return sortTopologically(nodes, "");
  } catch {
    return nodes;
  }
};

const caseNodes = (
  node: WorkflowNode,
  run: NodeRun | undefined,
): readonly WorkflowNode[] | null => {
  if (node.type === "loop") return node.nodes;
  if (node.type !== "switch") return null;
  if (run?.branch === undefined) return [];
  if (run.branch === "default") return node.default ?? [];
  return node.cases.find((c) => c.id === run.branch)?.nodes ?? [];
};

// The run folder holds no copy of an included file, so its steps come from state alone.
const stepsFromRuns = (runs: NodeRuns, parents: readonly string[]): readonly Step[] =>
  Object.entries(runs).map(([id, run]) => {
    const path = [...parents, id];
    const node = { id, type: run.nodeType, stage: null };
    return toStep(node, path, run, stepsFromRuns(run.nodes ?? {}, path));
  });

export const listSteps = (
  nodes: readonly WorkflowNode[],
  runs: NodeRuns,
  parents: readonly string[] = [],
): readonly Step[] =>
  inRunOrder(nodes).map((node) => {
    const run = runs[node.id];
    const path = [...parents, node.id];
    const nested = caseNodes(node, run);
    const children =
      nested === null
        ? stepsFromRuns(run?.nodes ?? {}, path)
        : listSteps(nested, run?.nodes ?? {}, path);
    const stage = node.type === "agent" ? (node.stage ?? null) : null;
    return toStep({ id: node.id, type: node.type, stage }, path, run, children);
  });
