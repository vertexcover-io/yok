import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  compilePlan,
  findWorkflowPath,
  orchestrateArgv,
  resolveWorkflowInputs,
  verdict,
  type WorkflowAgent,
  WorkflowError,
  type WorkflowPlan,
} from "@yok/core";
import {
  type IAgentProvider,
  type ITerminalHost,
  loadStartConfig,
  type PolicyLayer,
  type ResolvedTiers,
  type Result,
  type SavedPolicies,
  sessionEnv,
  tierLaunch,
  type WorkflowRun,
} from "@yok/sdk";
import {
  devPluginDir,
  type Registry,
  resolvePolicies,
  resolveTiers,
  selfArgv,
  writeShim,
} from "@yok/sdk/internal";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as z from "zod";
import { errorResponse, jsonBody, type Vars } from "./api.ts";
import { readRunFiles, summarizeLiveRun } from "./overview.ts";
import { addRunIfProjectKept, pickProject, saveVerdict } from "./projects.ts";
import { type StartRunBody, StartRunBodySchema } from "./protocol.ts";
// A type import only: server.ts imports app.ts, which imports this file.
import type { CheckCheckout } from "./server.ts";
import { filesBody, findViewedRun, readArtifact, streamRun } from "./viewer.ts";

export type RunDeps = Readonly<{
  registry: Registry;
  providerFor: (agent: WorkflowAgent) => IAgentProvider;
  host: ITerminalHost;
  home: string;
  viewerOrigin: string;
  checkCheckout: CheckCheckout;
  // Fired on shutdown: a run stream ends, since the server's stop waits for every open request.
  closing: AbortSignal;
}>;

const viewUrl = (deps: RunDeps, runId: string): string => `${deps.viewerOrigin}/runs/${runId}`;

// The run's tier set and policies, merged once here; init copies both into the run's state.
// The request's policies are the caller's layer; the workflow's come from the compiled plan.
const resolveRunSettings = async (
  config: string | null,
  cwd: string,
  plan: WorkflowPlan,
  cli: PolicyLayer,
): Promise<Result<Readonly<{ tiers: ResolvedTiers | null; policies: SavedPolicies }>>> => {
  const loaded = await loadStartConfig(config, cwd);
  if (!loaded.ok) return loaded;
  const tiers = resolveTiers(loaded.value.config, plan.agent, plan.tiers);
  if (!tiers.ok) return tiers;
  const policies = resolvePolicies({
    config: loaded.value.config.policies ?? {},
    workflow: plan.policies,
    cli,
  });
  return { ok: true, value: { tiers: tiers.value, policies } };
};

// Every refusal comes before registry.addRun, so a refused start records no run.
const startRun = async (c: Context<{ Variables: Vars }>, deps: RunDeps, body: StartRunBody) => {
  const log = c.get("log").child({ component: "runs" });
  const { inputs, name } = body;
  const project = await pickProject(deps.home, body.project);
  if (!project.ok) return errorResponse(c, 400, "bad-request", project.error);
  const cwd = project.value.path;
  // Checked before compiling, so a mistyped shipped workflow is not a compile error about a
  // file under the plugin folder.
  const workflowPath = findWorkflowPath(body.workflow, cwd);
  if (!existsSync(workflowPath)) {
    return errorResponse(c, 400, "bad-request", `no workflow at ${workflowPath}`);
  }
  const config = body.config === undefined ? null : resolve(cwd, body.config);
  const compiled = await compilePlan(workflowPath, cwd, config);
  if (!compiled.ok) return errorResponse(c, 400, "bad-request", compiled.error);
  const plan = compiled.value;
  const workflow = plan.name;
  const agent = plan.agent;

  const checked = await deps.checkCheckout({ cwd, plan, ...(config === null ? {} : { config }) });
  const line = verdict(checked.report);
  await saveVerdict(deps.home, project.value.name, line);
  if (checked.report.failed.length > 0) {
    log.info({ workflow, verdict: line }, "run not started: the doctor blocked it");
    return errorResponse(c, 400, "bad-request", line, checked.report);
  }
  if (!checked.env.ok) return errorResponse(c, 400, "bad-request", checked.env.error);

  const resolved = await resolveRunSettings(config, cwd, plan, body.policies ?? {});
  if (!resolved.ok) {
    log.error(
      { err: resolved.error, workflow, agent },
      "run not started: its tiers do not resolve",
    );
    return errorResponse(c, 400, "bad-request", resolved.error);
  }
  const { tiers, policies } = resolved.value;
  // The check `orchestrate next` makes on every step, so a run it would refuse is never saved.
  try {
    resolveWorkflowInputs(plan.inputs, inputs);
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    return errorResponse(c, 400, "bad-request", error.message);
  }

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
    config,
    tiers,
    policies,
    ...(body.source === undefined ? {} : { source: body.source }),
    createdAt: new Date().toISOString(),
  };
  const added = await addRunIfProjectKept(deps.home, project.value, () =>
    deps.registry.addRun(pending),
  );
  if (!added) {
    runLog.info({ project: project.value.name }, "run not started: its project was removed");
    return errorResponse(c, 409, "conflict", `project ${project.value.name} was removed`);
  }

  // A run whose agent never started is removed, so a failed start records nothing.
  const nameArg = name === undefined ? "" : ` --name ${name}`;
  const launched = await provider
    .launch({
      cwd,
      prompt: `${provider.skillPrefix}orchestrate --workflow ${workflowPath} --inputs ${JSON.stringify(inputs)}${nameArg}`,
      env: sessionEnv(checked.env.value, id, deps.home, writeShim(selfArgv(), deps.home)),
      pluginDir: devPluginDir(),
      orchestrateArgv: orchestrateArgv(),
      ...tierLaunch(tiers === null ? null : (tiers.models[tiers.default] ?? null)),
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
    return errorResponse(c, 502, "agent-failed", String(launched.error));
  }

  const { terminalName, terminal } = launched.value;
  await deps.registry.setTerminal(id, terminalName);
  const run = (await deps.registry.findRun(id)) ?? { ...pending, terminal: terminalName };
  runLog.info({ workflow, cwd, agent, terminalName }, "run started");
  return c.json({ run, attach: [...terminal.attachCommand()], view: viewUrl(deps, id) }, 201);
};

// Mounted at /runs by app.ts. Chained, so each route's input and output types reach AppType.
export const runRoutes = (deps: RunDeps) =>
  new Hono<{ Variables: Vars }>()
    .post("/", jsonBody(StartRunBodySchema), (c) => startRun(c, deps, c.req.valid("json")))
    .get("/view", (c) => c.json({ view: `${deps.viewerOrigin}/` }, 200))
    .get("/:id/view", async (c) => {
      const id = c.req.param("id");
      if ((await deps.registry.findRun(id)) === undefined) {
        return errorResponse(c, 404, "not-found", `no run with id ${id}`);
      }
      return c.json({ view: viewUrl(deps, id) }, 200);
    })
    .get("/:id", async (c) => {
      const id = c.req.param("id");
      const run = await deps.registry.findRun(id);
      if (run === undefined) return errorResponse(c, 404, "not-found", `no run with id ${id}`);
      return c.json({ run, summary: await summarizeLiveRun(run, deps.host) }, 200);
    })
    .get("/:id/files", async (c) => {
      const id = c.req.param("id");
      const page = await findViewedRun(deps.registry, id);
      if (page.kind === "missing") {
        return errorResponse(c, 404, "not-found", `no run with id ${id}`);
      }
      return c.json(await filesBody(page, (await readRunFiles(page.run)).state), 200);
    })
    .get("/:id/file", zValidator("query", z.strictObject({ path: z.string() })), async (c) => {
      const id = c.req.param("id");
      const { path } = c.req.valid("query");
      const page = await findViewedRun(deps.registry, id);
      const read = page.kind === "ready" ? await readArtifact(page, path) : null;
      if (read === null) return errorResponse(c, 404, "not-found", `run ${id} has no file ${path}`);
      return c.json(read, 200);
    })
    .get("/:id/stream", async (c) => {
      const id = c.req.param("id");
      if ((await findViewedRun(deps.registry, id)).kind === "missing") {
        return errorResponse(c, 404, "not-found", `no run with id ${id}`);
      }
      return streamSSE(c, (stream) => streamRun(stream, deps, id));
    });
