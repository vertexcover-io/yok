import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  builtInChecks,
  clearDeadSwitchLocks,
  type DoctorReport,
  loadStartEnv,
  orchestrateArgv,
  resolveWorkflowInputs,
  runDoctor,
  verdict,
  type WorkflowAgent,
  WorkflowAgentSchema,
  WorkflowError,
  type WorkflowPlan,
  workflowChecks,
} from "@yok/core";
import {
  type Check,
  createGit,
  type Event,
  type IAgentProvider,
  type ILogger,
  type ITerminalHost,
  type JsonObject,
  loadStartConfig,
  type ResolvedTiers,
  type Result,
  runDirOf,
  type SavedPolicies,
  type SessionRef,
  SessionStartCalledEvent,
  sessionEnv,
  tierLaunch,
  type WorkflowRun,
} from "@yok/sdk";
import {
  devPluginDir,
  foldModelSwitch,
  isRunLive,
  jsonlEventStore,
  type Registry,
  resolvePolicies,
  resolveTiers,
  selfArgv,
  writeShim,
} from "@yok/sdk/internal";
import type { Context } from "hono";
import { Hono } from "hono";
import { errorResponse, jsonBody, type Vars } from "./api.ts";
import { isAgentAlive, readStateOrNull, scheduleDelivery } from "./delivery.ts";
import {
  type ResumeRunBody,
  ResumeRunBodySchema,
  type StartRunBody,
  StartRunBodySchema,
  type StartRunRequest,
} from "./protocol.ts";

export type RunDeps = Readonly<{
  registry: Registry;
  providerFor: (agent: WorkflowAgent) => IAgentProvider;
  host: ITerminalHost;
  home: string;
  viewerOrigin: string;
}>;

export const blockedText = (report: DoctorReport): string =>
  [
    verdict(report),
    ...report.results
      .filter((row) => row.status === "fail")
      .flatMap((row) => [`${row.name}: ${row.detail}`, ...row.fix.map((step) => `  fix: ${step}`)]),
  ].join("\n");

const checkInputs = (plan: WorkflowPlan, inputs: JsonObject): Result<null> => {
  try {
    resolveWorkflowInputs(plan.inputs, inputs);
    return { ok: true, value: null };
  } catch (error) {
    if (error instanceof WorkflowError)
      return { ok: false, error: `${error.code}: ${error.message}` };
    throw error;
  }
};

export type PrepareRunOptions = Readonly<{
  plan: WorkflowPlan;
  workflowPath: string;
  cwd: string;
  config: string | null;
  inputs: JsonObject;
  // the agent's own checks, which only the caller's runtime knows
  checks: readonly Check[];
  log: ILogger;
}>;

// Everything `yok run` checks before it asks the server for a run: the inputs, the doctor and the
// session's env. The reply is the request to send, or why the run cannot start.
export const prepareRun = async ({
  plan,
  workflowPath,
  cwd,
  config,
  inputs,
  checks,
  log,
}: PrepareRunOptions): Promise<Result<StartRunRequest & { cwd: string }, string>> => {
  const checked = checkInputs(plan, inputs);
  if (!checked.ok) return checked;
  // Built once: the doctor's env checks and the session see the same values.
  const env = await loadStartEnv(config, cwd, plan);
  const report = await runDoctor({
    cwd,
    config: config ?? undefined,
    extraChecks: [...checks, ...workflowChecks(plan.doctor, env), ...builtInChecks(plan, env)],
    log,
  });
  if (verdict(report).startsWith("BLOCKED")) return { ok: false, error: blockedText(report) };
  const repoRoot = await createGit().repoRoot(cwd);
  if (repoRoot === null) return { ok: false, error: "not inside a git repository" };
  if (!env.ok) return { ok: false, error: env.error };
  return {
    ok: true,
    value: {
      workflow: plan.name,
      workflowPath,
      inputs,
      cwd: repoRoot,
      agent: plan.agent,
      env: env.value,
      tiers: plan.tiers,
      policies: { workflow: plan.policies },
      ...(config === null ? {} : { config }),
    },
  };
};

const viewUrl = (deps: RunDeps, runId: string): string => `${deps.viewerOrigin}/runs/${runId}`;

// The run's tier set and policies, merged once here; init copies both into the run's state.
const resolveRunSettings = async (
  body: StartRunBody,
): Promise<Result<Readonly<{ tiers: ResolvedTiers | null; policies: SavedPolicies }>>> => {
  const loaded = await loadStartConfig(body.config ?? null, body.cwd);
  if (!loaded.ok) return loaded;
  const { config } = loaded.value;
  const tiers = resolveTiers(config, body.agent, body.tiers);
  if (!tiers.ok) return tiers;
  const policies = resolvePolicies({ config: config.policies ?? {}, ...body.policies });
  return { ok: true, value: { tiers: tiers.value, policies } };
};

export type LaunchReply = Readonly<{
  run: WorkflowRun;
  attach: readonly string[];
  view: string;
}>;
export type LaunchError = Readonly<{
  status: 400 | 502;
  code: "bad-request" | "agent-failed";
  message: string;
}>;

// Starts the run's agent session; the /runs route and the trigger scheduler both call it.
export const launchRun = async (
  body: StartRunBody,
  deps: RunDeps,
  log: ILogger,
): Promise<Result<LaunchReply, LaunchError>> => {
  const { workflow, workflowPath, inputs, cwd, name, agent, config, permissionMode } = body;

  if (!existsSync(workflowPath) || !existsSync(cwd)) {
    return {
      ok: false,
      error: { status: 400, code: "bad-request", message: "workflowPath and cwd must exist" },
    };
  }

  const resolved = await resolveRunSettings(body);
  if (!resolved.ok) {
    log.error(
      { err: resolved.error, workflow, agent },
      "run not started: its tiers do not resolve",
    );
    return { ok: false, error: { status: 400, code: "bad-request", message: resolved.error } };
  }
  const { tiers, policies } = resolved.value;

  const provider = deps.providerFor(agent);

  const id = `r-${randomBytes(4).toString("hex")}`;
  const runLog = log.child({ runId: id });
  // Saved before the agent starts: its first step is `orchestrate init`, which must find the run.
  const pending: WorkflowRun = {
    id,
    workflow,
    workflowPath,
    inputs,
    cwd,
    sessions: [],
    name: null,
    terminal: null,
    config: config ?? null,
    tiers,
    policies,
    ...(permissionMode === undefined ? {} : { permissionMode }),
    createdAt: new Date().toISOString(),
  };
  await deps.registry.addRun(pending);

  // A run whose agent never started is removed, so a failed start records nothing.
  const nameArg = name === undefined ? "" : ` --name ${name}`;
  const launched = await provider
    .launch({
      cwd,
      prompt: `${provider.skillPrefix}orchestrate --workflow ${workflowPath} --inputs ${JSON.stringify(inputs)}${nameArg}`,
      env: sessionEnv(body.env, id, deps.home, writeShim(selfArgv(), deps.home)),
      pluginDir: devPluginDir(),
      orchestrateArgv: orchestrateArgv(),
      ...tierLaunch(tiers === null ? null : (tiers.models[tiers.default] ?? null)),
      ...(permissionMode === undefined ? {} : { permissionMode }),
    })
    .catch(async (error: unknown) => {
      await deps.registry.removeRun(id);
      throw error;
    });
  if (!launched.ok) {
    await deps.registry.removeRun(id);
    runLog.error(
      { err: String(launched.error) },
      "run not started: the agent session failed to launch",
    );
    return {
      ok: false,
      error: { status: 502, code: "agent-failed", message: String(launched.error) },
    };
  }

  const { terminalName, terminal } = launched.value;
  await deps.registry.setTerminal(id, terminalName);
  const run = (await deps.registry.findRun(id)) ?? { ...pending, terminal: terminalName };
  runLog.info({ workflow, cwd, agent, terminalName }, "run started");
  return {
    ok: true,
    value: { run, attach: [...terminal.attachCommand()], view: viewUrl(deps, id) },
  };
};

const startRun = async (c: Context<{ Variables: Vars }>, deps: RunDeps, body: StartRunBody) => {
  const launched = await launchRun(body, deps, c.get("log").child({ component: "runs" }));
  if (!launched.ok) {
    const { status, code, message } = launched.error;
    return errorResponse(c, status, code, message);
  }
  return c.json(launched.value, 201);
};

const conflict = (c: Context<{ Variables: Vars }>, message: string) =>
  errorResponse(c, 409, "conflict", message);

// A context new step links its session before Claude starts on it and keeps the link when the
// relaunch fails, so the registry's last session may never have started; the event log knows.
const lastStartedSession = (events: readonly Event[]): SessionRef | undefined =>
  events
    .flatMap((event) => {
      if (event.type !== "hooks.session-start.called") return [];
      const parsed = SessionStartCalledEvent.safeParse(event);
      if (!parsed.success) return [];
      const { agent, sessionId } = parsed.data.payload;
      return [{ agent, sessionId }];
    })
    .at(-1);

// Brings back a run whose agent session is gone: the last linked session continues on the
// model the run was on, in a tmux session under the run's old name.
const resumeRun = async (
  c: Context<{ Variables: Vars }>,
  deps: RunDeps,
  id: string,
  body: ResumeRunBody,
) => {
  const log = c.get("log").child({ component: "runs", runId: id });
  const run = await deps.registry.findRun(id);
  if (run === undefined) return errorResponse(c, 404, "not-found", `no run with id ${id}`);
  const linked = run.sessions.at(-1);
  if (run.name === null || run.terminal === null || linked === undefined) {
    return conflict(c, `run ${id} never started its agent session; start it again with yok run`);
  }
  const runDir = runDirOf(run.cwd, run.name);
  const state = await readStateOrNull(runDir);
  if (state === null) return conflict(c, `run ${run.name} has no readable state in ${runDir}`);
  if (!isRunLive(state.status)) {
    return conflict(
      c,
      `run ${run.name} is ${state.status}; there is nothing to resume, so start a new run with yok run`,
    );
  }
  if (await isAgentAlive(run, deps.host)) {
    return conflict(c, `run ${run.name} still has its agent session; use yok attach ${run.name}`);
  }
  const events = await jsonlEventStore(runDir).read();
  const session = lastStartedSession(events) ?? linked;
  const agent = WorkflowAgentSchema.safeParse(session.agent);
  if (!agent.success) {
    return conflict(c, `run ${run.name} ran on ${session.agent}, which yok cannot resume`);
  }

  const { removed, held } = await clearDeadSwitchLocks(runDir, state, events);
  if (removed.length > 0) log.info({ locks: removed }, "dead switch locks removed");
  // A live helper would take the resumed session's SessionStart as its own switch's.
  if (held.length > 0) {
    return conflict(
      c,
      `run ${run.name} is still switching its model or context; try again in a minute`,
    );
  }

  const provider = deps.providerFor(agent.data);
  const { current } = foldModelSwitch(events, state.tiers);
  const launched = await provider.launch({
    cwd: run.cwd,
    prompt: `${provider.skillPrefix}orchestrate --resume ${run.name}`,
    env: sessionEnv(body.env, id, deps.home, writeShim(selfArgv(), deps.home)),
    pluginDir: devPluginDir(),
    orchestrateArgv: orchestrateArgv(),
    continueSession: { id: session.sessionId, terminalName: run.terminal },
    ...tierLaunch(current),
    ...(run.permissionMode === undefined ? {} : { permissionMode: run.permissionMode }),
  });
  // The run is left as it was: removing it, as a failed start does, would lose it.
  if (!launched.ok) {
    log.error(
      { err: String(launched.error) },
      "run not resumed: the agent session failed to launch",
    );
    return errorResponse(c, 502, "agent-failed", String(launched.error));
  }
  log.info(
    {
      agent: agent.data,
      sessionId: session.sessionId,
      terminal: run.terminal,
      model: current?.model,
    },
    "run resumed",
  );
  // Comments posted while the session was down; delivery waits until the agent is ready for them.
  void scheduleDelivery(id, { ...deps, log, now: () => new Date() });
  return c.json(
    { run, attach: [...launched.value.terminal.attachCommand()], view: viewUrl(deps, id) },
    200,
  );
};

// Mounted at /runs by app.ts. Chained, so each route's input and output types reach AppType.
export const runRoutes = (deps: RunDeps) =>
  new Hono<{ Variables: Vars }>()
    .post("/", jsonBody(StartRunBodySchema), (c) => startRun(c, deps, c.req.valid("json")))
    .post("/:id/resume", jsonBody(ResumeRunBodySchema), (c) =>
      resumeRun(c, deps, c.req.param("id"), c.req.valid("json")),
    )
    .get("/view", (c) => c.json({ view: `${deps.viewerOrigin}/` }, 200))
    .get("/:id/view", async (c) => {
      const id = c.req.param("id");
      if ((await deps.registry.findRun(id)) === undefined) {
        return errorResponse(c, 404, "not-found", `no run with id ${id}`);
      }
      return c.json({ view: viewUrl(deps, id) }, 200);
    });
