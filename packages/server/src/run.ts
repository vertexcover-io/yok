import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  compilePlan,
  findWorkflowPath,
  orchestrateArgv,
  verdict,
  type WorkflowAgent,
  type WorkflowPlan,
} from "@yok/core";
import {
  type IAgentProvider,
  loadStartConfig,
  type ResolvedTiers,
  type Result,
  sessionEnv,
  tierLaunch,
  type WorkflowRun,
} from "@yok/sdk";
import { devPluginDir, type Registry, resolveTiers, selfArgv, writeShim } from "@yok/sdk/internal";
import type { Context } from "hono";
import { Hono } from "hono";
import { errorResponse, jsonBody, type Vars } from "./api.ts";
import { pickProject, saveVerdict } from "./projects.ts";
import { type StartRunBody, StartRunBodySchema } from "./protocol.ts";
// A type import only: server.ts imports app.ts, which imports this file.
import type { CheckCheckout } from "./server.ts";

export type RunDeps = Readonly<{
  registry: Registry;
  providerFor: (agent: WorkflowAgent) => IAgentProvider;
  home: string;
  viewerOrigin: string;
  checkCheckout: CheckCheckout;
}>;

const viewUrl = (deps: RunDeps, runId: string): string => `${deps.viewerOrigin}/runs/${runId}`;

// The run's tier set, merged once here; init copies it into the run's state.
const resolveRunTiers = async (
  config: string | null,
  cwd: string,
  plan: WorkflowPlan,
): Promise<Result<ResolvedTiers | null>> => {
  const loaded = await loadStartConfig(config, cwd);
  if (!loaded.ok) return loaded;
  return resolveTiers(loaded.value.config, plan.agent, plan.tiers);
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

  const resolved = await resolveRunTiers(config, cwd, plan);
  if (!resolved.ok) {
    log.error(
      { err: resolved.error, workflow, agent },
      "run not started: its tiers do not resolve",
    );
    return errorResponse(c, 400, "bad-request", resolved.error);
  }
  const tiers = resolved.value;

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
    createdAt: new Date().toISOString(),
  };
  await deps.registry.addRun(pending);

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
    });
