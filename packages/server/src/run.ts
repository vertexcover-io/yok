import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  clearDeadSwitchLocks,
  compilePlan,
  compileRunWorkflow,
  locateWorkflow,
  orchestrateArgv,
  pickNotifier,
  resolveWorkflowInputs,
  retryFailedSteps,
  unwrap,
  verdict,
  type WorkflowAgent,
  WorkflowAgentSchema,
  WorkflowError,
  type WorkflowPlan,
} from "@yok/core";
import {
  type Event,
  type IAgentProvider,
  type IGit,
  type ILogger,
  type IStorage,
  type ITerminalHost,
  type JsonObject,
  type JsonValue,
  loadEnv,
  loadRunConfig,
  loadStartConfig,
  type Notifier,
  type PermissionMode,
  type PolicyLayer,
  type ResolvedTiers,
  type Result,
  type RunRef,
  resolveRun,
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
  type RunDraft,
  resolvePolicies,
  resolveTiers,
  selfArgv,
  writeShim,
} from "@yok/sdk/internal";
import type { Context } from "hono";
import { Hono } from "hono";
import { errorResponse, jsonBody, queryParams, type Vars } from "./api.ts";
import { isAgentAlive, readStateOrNull, scheduleDelivery } from "./delivery.ts";
import { forgetFinishedRun, type ListedRun, listRunSummaries, ownerMatches } from "./overview.ts";
import { deleteRun, holdsCheckout, pickProject, refuseBody } from "./projects.ts";
import {
  type DoctorBody,
  DoctorBodySchema,
  ListRunsQuerySchema,
  type ResumeRunBody,
  ResumeRunBodySchema,
  type RetryRunBody,
  RetryRunBodySchema,
  type RunPick,
  type RunsFilter,
  type StartRunBody,
  StartRunBodySchema,
} from "./protocol.ts";
// A type import only: server.ts imports app.ts, which imports this file.
import type { CheckCheckout } from "./server.ts";

export type RunDeps = Readonly<{
  storage: IStorage;
  providerFor: (agent: WorkflowAgent) => IAgentProvider;
  host: ITerminalHost;
  home: string;
  // where every dashboard link starts: https://SERVER_DOMAIN, else http://localhost:PORT
  publicOrigin: string;
  checkCheckout: CheckCheckout;
}>;

export type GitDeps = Readonly<{ git: IGit }>;

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

const viewUrl = (deps: RunDeps, runId: string): string => `${deps.publicOrigin}/runs/${runId}`;

// The run's tier set and policies, merged once here; init copies both into the run's state.
// The caller's layer wins over the workflow's, which comes from the compiled plan.
const resolveRunSettings = async (
  config: string | null,
  cwd: string,
  plan: WorkflowPlan,
  cli: PolicyLayer,
): Promise<
  Result<
    Readonly<{
      tiers: ResolvedTiers | null;
      policies: SavedPolicies;
      notifier: Notifier | undefined;
    }>
  >
> => {
  const loaded = await loadStartConfig(config, cwd);
  if (!loaded.ok) return loaded;
  const tiers = resolveTiers(loaded.value.config, plan.agent, plan.tiers);
  if (!tiers.ok) return tiers;
  const policies = resolvePolicies({
    config: loaded.value.config.policies ?? {},
    workflow: plan.policies,
    cli,
  });
  const notifier = pickNotifier(plan.notifier, loaded.value.config.notifier);
  return { ok: true, value: { tiers: tiers.value, policies, notifier } };
};

// The channel a Slack command was typed in, the ts of its thread's first message, and the
// Slack user id of whoever typed it.
export type ChatThread = Readonly<{ channel: string; ts: string; user?: string }>;

// A run started from a chat thread replies in it: its Slack notifier posts to the thread's
// channel and addresses whoever typed the command, whatever the project's env names. Empty when
// the run has no thread or its notifier is off, in which case no updates follow in the thread.
const threadEnv = (
  thread: ChatThread | undefined,
  notifier: Notifier | undefined,
): Readonly<Record<string, string>> =>
  thread === undefined || notifier?.enabled !== true
    ? {}
    : {
        SLACK_CHANNEL_ID: thread.channel,
        YOK_SLACK_THREAD: thread.ts,
        ...(thread.user === undefined ? {} : { SLACK_MEMBER_ID: thread.user }),
      };

type LaunchReply = Readonly<{
  run: WorkflowRun;
  attach: readonly string[];
  view: string;
  // set only for a start from a chat thread: whether the run's updates reply in it
  threaded?: boolean;
}>;
export type LaunchError = Readonly<{
  status: 400 | 409 | 422 | 502;
  code: "bad-request" | "conflict" | "agent-failed" | "git-failed";
  message: string;
  details?: JsonValue;
}>;

export type LaunchRequest = Readonly<{
  plan: WorkflowPlan;
  workflowPath: string;
  // the project the run belongs to; cwd is that project's folder
  project: string;
  cwd: string;
  config: string | null;
  inputs: JsonObject;
  name?: string;
  policies: PolicyLayer;
  permissionMode?: PermissionMode;
  thread?: ChatThread;
  source: RunSource;
  // the yok user who started it, when one did
  user?: string;
  // Saves the run unless what it starts from went away during the checks.
  register: (add: () => Promise<void>) => Promise<Result<null, string>>;
}>;

const refused = (
  status: LaunchError["status"],
  code: LaunchError["code"],
  message: string,
  details?: JsonValue,
): Result<never, LaunchError> => ({
  ok: false,
  error: { status, code, message, ...(details === undefined ? {} : { details }) },
});

// Checks a compiled workflow and starts its agent session; the /runs route and the trigger
// scheduler both call it. Every refusal comes before register, so a refused start records no run.
export const launchRun = async (
  request: LaunchRequest,
  deps: RunDeps,
  log: ILogger,
): Promise<Result<LaunchReply, LaunchError>> => {
  const { plan, workflowPath, project, cwd, config, inputs, name, permissionMode, source, user } =
    request;
  const workflow = plan.name;
  const agent = plan.agent;
  const checkedInputs = checkInputs(plan, inputs);
  if (!checkedInputs.ok) return refused(400, "bad-request", checkedInputs.error);

  const checked = await deps.checkCheckout({ cwd, plan, ...(config === null ? {} : { config }) });
  const line = verdict(checked.report);
  if (checked.report.failed.length > 0) {
    log.info({ workflow, verdict: line }, "run not started: the doctor blocked it");
    return refused(400, "bad-request", line, checked.report);
  }
  if (!checked.env.ok) return refused(400, "bad-request", checked.env.error);

  const resolved = await resolveRunSettings(config, cwd, plan, request.policies);
  if (!resolved.ok) {
    log.error(
      { err: resolved.error, workflow, agent },
      "run not started: its tiers do not resolve",
    );
    return refused(400, "bad-request", resolved.error);
  }
  const { tiers, policies, notifier } = resolved.value;
  const threaded = threadEnv(request.thread, notifier);

  const provider = deps.providerFor(agent);
  const id = `r-${randomBytes(4).toString("hex")}`;
  const runLog = log.child({ runId: id });
  // Saved before the agent starts: its first step is `orchestrate init`, which must find the run.
  const pending: RunDraft = {
    id,
    project,
    workflow,
    workflowPath,
    inputs,
    sessions: [],
    name: null,
    terminal: null,
    config,
    tiers,
    policies,
    ...(permissionMode === undefined ? {} : { permissionMode }),
    source,
    ...(user === undefined ? {} : { user }),
    createdAt: new Date().toISOString(),
  };
  const registered = await request.register(() => deps.storage.runs.addRun(pending));
  if (!registered.ok) {
    runLog.info({ reason: registered.error }, "run not started");
    return refused(409, "conflict", registered.error);
  }

  // A run whose agent never started is removed, so a failed start records nothing.
  const nameArg = name === undefined ? "" : ` --name ${name}`;
  const launched = await provider
    .launch({
      cwd,
      prompt: `${provider.skillPrefix}orchestrate --workflow ${workflowPath} --inputs ${JSON.stringify(inputs)}${nameArg}`,
      env: {
        ...(await sessionEnv(
          deps.storage,
          checked.env.value,
          id,
          deps.home,
          writeShim(selfArgv(), deps.home),
        )),
        ...threaded,
      },
      pluginDir: devPluginDir(),
      orchestrateArgv: orchestrateArgv(),
      ...tierLaunch(tiers === null ? null : (tiers.models[tiers.default] ?? null)),
      ...(permissionMode === undefined ? {} : { permissionMode }),
    })
    .catch(async (error: unknown) => {
      await deps.storage.runs.removeRun(id);
      throw error;
    });
  if (!launched.ok) {
    await deps.storage.runs.removeRun(id);
    runLog.error(
      { err: String(launched.error) },
      "run not started: the agent session failed to launch",
    );
    return refused(502, "agent-failed", String(launched.error));
  }

  const { terminalName, terminal } = launched.value;
  await deps.storage.runs.setTerminal(id, terminalName);
  const run = (await deps.storage.runs.findRun(id)) ?? { ...pending, cwd, terminal: terminalName };
  runLog.info({ workflow, cwd, agent, terminalName }, "run started");
  return {
    ok: true,
    value: {
      run,
      attach: [...terminal.attachCommand()],
      view: viewUrl(deps, id),
      ...(request.thread === undefined
        ? {}
        : { threaded: threaded.YOK_SLACK_THREAD !== undefined }),
    },
  };
};

export type RunSource = NonNullable<WorkflowRun["source"]>;

export type StartExtra = Readonly<{
  source: RunSource;
  permissionMode?: PermissionMode;
  thread?: ChatThread;
  user?: string;
  // Asked just before the run is registered; false refuses the start with a conflict.
  stillWanted?: () => Promise<boolean>;
}>;

// Checked before compiling, so a mistyped shipped workflow is not a compile error about a
// file under the plugin folder.
export const compileWorkflow = async (
  workflow: string,
  cwd: string,
  config: string | null,
): Promise<Result<Readonly<{ plan: WorkflowPlan; workflowPath: string }>>> => {
  const located = await locateWorkflow(workflow, cwd, config);
  if (!located.ok) return located;
  const workflowPath = located.value;
  if (!existsSync(workflowPath)) return { ok: false, error: `no workflow at ${workflowPath}` };
  const compiled = await compilePlan(workflowPath, cwd, config);
  return compiled.ok ? { ok: true, value: { plan: compiled.value, workflowPath } } : compiled;
};

// The one start-up path: POST /runs, trigger firings and the Slack run command all start here.
// A project yok cloned is pulled first, and every refusal comes before the run is registered.
export const startProjectRun = async (
  body: StartRunBody,
  deps: RunDeps & GitDeps,
  log: ILogger,
  extra: StartExtra,
): Promise<Result<LaunchReply, LaunchError>> => {
  const project = await pickProject(deps.storage, deps.home, body.project);
  if (!project.ok) return refused(400, "bad-request", project.error);
  const cwd = project.value.path;
  if (project.value.cloned) {
    const pulled = await deps.git.pullFastForward(cwd);
    if (!pulled.ok) {
      log.info(
        { project: project.value.name, err: pulled.error },
        "run not started: git pull failed",
      );
      return refused(422, "git-failed", "git pull --ff-only failed; see the server log");
    }
  }
  const config = body.config === undefined ? null : resolve(cwd, body.config);
  const compiled = await compileWorkflow(body.workflow, cwd, config);
  if (!compiled.ok) return refused(400, "bad-request", compiled.error);
  const { permissionMode, stillWanted, thread, source, user } = extra;
  return launchRun(
    {
      ...compiled.value,
      project: project.value.name,
      cwd,
      config,
      inputs: body.inputs,
      ...(body.name === undefined ? {} : { name: body.name }),
      policies: body.policies ?? {},
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(thread === undefined ? {} : { thread }),
      source,
      ...(user === undefined ? {} : { user }),
      register: async (add) => {
        if (stillWanted !== undefined && !(await stillWanted())) {
          return { ok: false, error: "withdrawn while the run was being checked" };
        }
        // The run row names its project, so the insert fails once the project is gone.
        const failed = await add().then(
          () => null,
          (error: unknown) => error,
        );
        if (failed === null) return { ok: true, value: null };
        if ((await deps.storage.projects.find(project.value.name)) !== undefined) throw failed;
        return { ok: false, error: `project ${project.value.name} was removed` };
      },
    },
    deps,
    log,
  );
};

const startRun = async (
  c: Context<{ Variables: Vars }>,
  deps: RunDeps & GitDeps,
  body: StartRunBody,
) => {
  const user = c.get("caller")?.userId;
  const launched = await startProjectRun(body, deps, c.get("log").child({ component: "runs" }), {
    source: "api",
    ...(user === undefined ? {} : { user }),
  });
  if (!launched.ok) {
    const { status, code, message, details } = launched.error;
    return errorResponse(c, status, code, message, details);
  }
  return c.json(launched.value, 201);
};

// The doctor on request: the checkout's checks, plus the workflow's when one is named. The
// report is returned and nothing is stored, and a cloned project is not pulled.
const runProjectDoctor = async (
  c: Context<{ Variables: Vars }>,
  deps: RunDeps,
  body: DoctorBody,
) => {
  const project = await pickProject(deps.storage, deps.home, body.project);
  if (!project.ok) return errorResponse(c, 400, "bad-request", project.error);
  const cwd = project.value.path;
  if (body.workflow === undefined) {
    const { report } = await deps.checkCheckout({ cwd });
    return c.json({ report }, 200);
  }
  const compiled = await compileWorkflow(body.workflow, cwd, null);
  if (!compiled.ok) return errorResponse(c, 400, "bad-request", compiled.error);
  const { report } = await deps.checkCheckout({ cwd, plan: compiled.value.plan });
  return c.json({ report }, 200);
};

const conflict = (c: Context<{ Variables: Vars }>, message: string) =>
  errorResponse(c, 409, "conflict", message);

// A context new step links its session before Claude starts on it and keeps the link when the
// relaunch fails, so the run's last linked session may never have started; the event log knows.
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

// The id of the run a resume or retry names. A name is looked up among the project's runs, as
// yok resume NAME does in that checkout.
const findRunId = async (deps: RunDeps, pick: RunPick): Promise<Result<string>> => {
  if ("id" in pick) return { ok: true, value: pick.id };
  const project = await pickProject(deps.storage, deps.home, pick.project);
  if (!project.ok) return project;
  const named = await resolveRun({
    storage: deps.storage,
    root: project.value.path,
    name: pick.name,
  });
  return named.ok ? { ok: true, value: named.value.id } : named;
};

// What launchRun checks before a new session, for a run that already has a workflow and config:
// the doctor over the env the session gets, built as every later session of the run builds it.
const checkRelaunch = async (
  deps: RunDeps,
  run: RunRef,
  agent: WorkflowAgent,
): Promise<Result<Record<string, string>, LaunchError>> => {
  const loaded = await (async () => {
    const config = unwrap(await loadRunConfig(run, deps.storage));
    // the doctor and env follow the agent this session resumes on, which may not be the workflow's
    const plan = { ...(await compileRunWorkflow(run, config)), agent };
    return { config, plan, env: await loadEnv(config, plan, run.cwd) };
  })().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (loaded instanceof Error) {
    return refused(409, "conflict", `run ${run.name} cannot start a session: ${loaded.message}`);
  }
  const { config, plan, env } = loaded;
  const checked = await deps.checkCheckout({
    cwd: run.cwd,
    plan,
    env,
    ...(config.path === null ? {} : { config: config.path }),
  });
  if (checked.report.failed.length > 0) {
    return refused(400, "bad-request", verdict(checked.report), checked.report);
  }
  return env.ok ? env : refused(400, "bad-request", env.error);
};

// Brings back a run whose agent session is gone, finished or not: the last linked session
// continues on the model the run was on, in a tmux session under the run's old name. A finished
// run's resumed session stays open as a chat. The doctor runs after the guards; a retry then
// reopens a failed run's failed steps, before the launch.
const relaunchRun = async (
  c: Context<{ Variables: Vars }>,
  deps: RunDeps,
  body: ResumeRunBody,
  retry?: Readonly<{ answered: boolean }>,
) => {
  const found = await findRunId(deps, body.run);
  if (!found.ok) return errorResponse(c, 404, "not-found", found.error);
  const id = found.value;
  const log = c.get("log").child({ component: "runs", runId: id });
  const run = await deps.storage.runs.findRun(id);
  if (run === undefined) return errorResponse(c, 404, "not-found", `no run with id ${id}`);
  // A relaunch launches with the owner's GitHub token, so only the owner may ask for one.
  const caller = c.get("caller");
  if (caller !== undefined && run.user !== undefined && run.user !== caller.userId) {
    const owner = (await deps.storage.users.find(run.user))?.name ?? "another person";
    const message = `run ${run.name ?? id} belongs to ${owner}; only ${owner} can resume or retry it`;
    return errorResponse(c, 403, "forbidden", message);
  }
  const linked = run.sessions.at(-1);
  if (run.name === null || run.terminal === null || linked === undefined) {
    return conflict(c, `run ${id} never started its agent session; start it again with yok run`);
  }
  const runDir = runDirOf(run.cwd, run.name);
  const state = await readStateOrNull(deps.storage, id);
  if (state === null) return conflict(c, `run ${run.name} has no readable state`);
  const stillAlive = `run ${run.name} still has its agent session; use yok attach ${run.name}`;
  if (await isAgentAlive(run, deps.host)) return conflict(c, stillAlive);
  const events = await deps.storage.runs.readEvents(id);
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

  const checked = await checkRelaunch(deps, { id, cwd: run.cwd, name: run.name }, agent.data);
  if (!checked.ok) {
    const { status, code, message, details } = checked.error;
    log.info({ err: message }, "run not relaunched: its checks failed");
    return errorResponse(c, status, code, message, details);
  }
  // The doctor takes seconds, in which another resume or retry of this run may have launched.
  if (await isAgentAlive(run, deps.host)) return conflict(c, stillAlive);

  if (retry !== undefined) {
    const reopened = await retryFailedSteps(
      deps.storage,
      { id, cwd: run.cwd, name: run.name },
      retry.answered,
    );
    if (!reopened.ok) return conflict(c, reopened.error);
    forgetFinishedRun(runDir);
  }

  const provider = deps.providerFor(agent.data);
  const { current } = foldModelSwitch(events, state.tiers);
  const launched = await provider.launch({
    cwd: run.cwd,
    prompt: `${provider.skillPrefix}orchestrate --resume ${run.name}`,
    env: await sessionEnv(
      deps.storage,
      checked.value,
      id,
      deps.home,
      writeShim(selfArgv(), deps.home),
    ),
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
    const reopened =
      retry === undefined
        ? ""
        : `; its failed steps are reopened, so yok resume ${run.name} starts it`;
    return errorResponse(c, 502, "agent-failed", `${String(launched.error)}${reopened}`);
  }
  log.info(
    {
      agent: agent.data,
      sessionId: session.sessionId,
      terminal: run.terminal,
      model: current?.model,
    },
    retry === undefined ? "run resumed" : "run retried",
  );
  // Comments posted while the session was down; delivery waits until the agent is ready for them.
  void scheduleDelivery(id, { ...deps, log });
  return c.json(
    { run, attach: [...launched.value.terminal.attachCommand()], view: viewUrl(deps, id) },
    200,
  );
};

const RUNS_SHOWN = 20;

// Filters run before the cut, so total counts only the runs that match.
const listRuns = async (c: Context<{ Variables: Vars }>, deps: RunDeps, query: RunsFilter) => {
  const projects = Object.entries(await deps.storage.projects.list());
  if (query.project !== undefined && !projects.some(([name]) => name === query.project)) {
    return errorResponse(c, 404, "not-found", `no project named ${query.project}`);
  }
  const projectAt = (cwd: string): string | null =>
    projects.find(([, project]) => project.path === cwd)?.[0] ?? null;
  const listed: readonly ListedRun[] = (await listRunSummaries(deps.storage, deps.host)).map(
    (run) => ({ ...run, project: projectAt(run.cwd) }),
  );
  const matched = listed.filter(
    (run) =>
      (query.project === undefined || run.project === query.project) &&
      (query.status === undefined || query.status.includes(run.status)) &&
      (query.by === undefined || ownerMatches(run.startedBy, query.by)),
  );
  const runs = query.all === "true" ? matched : matched.slice(0, query.limit ?? RUNS_SHOWN);
  return c.json({ runs, total: matched.length }, 200);
};

// yok rm: a run still going keeps everything, so its agent never loses its folder mid-step.
const removeRun = async (c: Context<{ Variables: Vars }>, deps: RunDeps, id: string) => {
  const run = await deps.storage.runs.findRun(id);
  if (run === undefined) return errorResponse(c, 404, "not-found", `no run with id ${id}`);
  if (await holdsCheckout(deps.storage, run, deps.host)) {
    return conflict(
      c,
      `run ${run.name ?? id} is still going; yok rm removes only a run that has finished or lost its session`,
    );
  }
  await deleteRun(deps.storage, run, deps.host);
  c.get("log").child({ component: "runs", runId: id }).info({ name: run.name }, "run removed");
  return c.json({ removed: id }, 200);
};

// Mounted at /runs by app.ts. Chained, so each route's input and output types reach ApiType.
export const runRoutes = (deps: RunDeps & GitDeps) =>
  new Hono<{ Variables: Vars }>()
    .post(
      "/",
      zValidator("json", StartRunBodySchema, (result, c) =>
        result.success ? undefined : refuseBody(c, result.error),
      ),
      (c) => startRun(c, deps, c.req.valid("json")),
    )
    .post("/resume", jsonBody(ResumeRunBodySchema), (c) =>
      relaunchRun(c, deps, c.req.valid("json")),
    )
    .post("/retry", jsonBody(RetryRunBodySchema), (c) => {
      const { answered, ...body }: RetryRunBody = c.req.valid("json");
      return relaunchRun(c, deps, body, { answered: answered ?? false });
    })
    .get("/", queryParams(ListRunsQuerySchema), (c) => listRuns(c, deps, c.req.valid("query")))
    .get("/view", (c) => c.json({ view: `${deps.publicOrigin}/` }, 200))
    .get("/:id/view", async (c) => {
      const id = c.req.param("id");
      if ((await deps.storage.runs.findRun(id)) === undefined) {
        return errorResponse(c, 404, "not-found", `no run with id ${id}`);
      }
      return c.json({ view: viewUrl(deps, id) }, 200);
    })
    .delete("/:id", (c) => removeRun(c, deps, c.req.param("id")));

// Mounted at /doctor by app.ts.
export const doctorRoutes = (deps: RunDeps) =>
  new Hono<{ Variables: Vars }>().post(
    "/",
    zValidator("json", DoctorBodySchema, (result, c) =>
      result.success ? undefined : refuseBody(c, result.error),
    ),
    (c) => runProjectDoctor(c, deps, c.req.valid("json")),
  );
