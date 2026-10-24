import { resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import {
  builtInChecks,
  compileRunWorkflow,
  findWorkflowPath,
  runDoctor,
  verdict,
  type WorkflowPlan,
  workflowChecks,
} from "@yok/core";
import {
  type ILogger,
  loadEnv,
  loadRunConfig,
  POLICY_NAMES,
  PoliciesSchema,
  type Result,
  registryPath,
  requireRun,
  spawnInteractive,
} from "@yok/sdk";
import { createRegistry, isCompiled, parsePolicyFlags, VERSION } from "@yok/sdk/internal";
import { blockedText, prepareRun, runtimeChecks } from "@yok/server";
import {
  apiErrorText,
  cliLog,
  commandLog,
  compileOrFail,
  ensureServer,
  errorText,
  fail,
  openForPerson,
  yokClient,
} from "./client.ts";
import { writeProjectTypes } from "./types.ts";

const collectInput = (pair: string, acc: Record<string, string>): Record<string, string> => {
  const index = pair.indexOf("=");
  if (index === -1) throw new Error(`--input must be KEY=VALUE, got "${pair}"`);
  return { ...acc, [pair.slice(0, index)]: pair.slice(index + 1) };
};

// The run's saved policies have no say here: an unattended run can still be watched.
export const followUps = ({
  open,
  attach,
  hasTerminal,
}: {
  open: boolean;
  attach: boolean;
  hasTerminal: boolean;
}): { noOpen: boolean; attach: boolean } => ({ noOpen: !open, attach: attach && hasTerminal });

// The doctor yok run and yok resume run before the server: the runtime, workflow and built-in
// checks over the env the session will get. Returns why the run is blocked, or null.
const checkBeforeStart = async (
  cwd: string,
  config: string | undefined,
  plan: WorkflowPlan,
  env: Result<Record<string, string>>,
): Promise<string | null> => {
  const report = await runDoctor({
    cwd,
    config,
    extraChecks: [
      ...runtimeChecks(plan.agent),
      ...workflowChecks(plan.doctor, env),
      ...builtInChecks(plan, env),
    ],
    log: cliLog(),
  });
  return verdict(report).startsWith("BLOCKED") ? blockedText(report) : null;
};

// Only what is read here: the server client's JSON type for a run is looser than WorkflowRun.
type StartedRun = Readonly<{
  run: Readonly<{ id: string; terminal: string | null }>;
  attach: readonly string[];
  view: string;
}>;

const showStartedRun = async (
  { run, attach, view }: StartedRun,
  flags: Readonly<{ open: boolean; attach: boolean }>,
  cwd: string,
  log: ILogger,
): Promise<void> => {
  console.log(run.id);
  console.log(`${isCompiled ? "yok" : "yok-dev"} attach --run-id ${run.id}`);
  console.log(`view: ${view}`);
  // A script, CI job or test has no terminal for tmux to attach to.
  const hasTerminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const next = followUps({ open: flags.open, attach: flags.attach, hasTerminal });
  openForPerson(view, next.noOpen);
  if (!next.attach) return;
  const [command, ...args] = attach;
  // Without TMUX, the attach also works from inside the user's own tmux.
  const exitCode = await spawnInteractive(command as string, args, {
    cwd,
    env: { TMUX: undefined },
  });
  log.info({ runId: run.id, terminal: run.terminal, exitCode }, "detached from the session");
  process.exitCode = exitCode;
};

export const runCommand = () => {
  const command = new Command("run")
    .argument("<workflow>", "shipped workflow name (e.g. task), or workflow file to run")
    .requiredOption("--prompt <text>", "first message sent to the agent")
    .option("--name <name>", "run name (default: derived from the prompt)")
    .option("--input <key=value>", "extra input, repeatable", collectInput, {})
    .option("--no-attach", "do not attach to the session's terminal once it starts")
    .option("--config <file>", "orchestrate config file the run reads (default: the checkout's)")
    .option("--no-open", "do not open the run's page in the browser")
    .action(async (workflowArg, opts) => {
      const log = commandLog("run");
      const cwd = process.cwd();
      // the flags are read as YAML and checked, so a bad value fails before anything starts
      const cliPolicies = parsePolicyFlags(opts);
      if (!cliPolicies.ok) return fail(cliPolicies.error);
      const workflowPath = findWorkflowPath(workflowArg, cwd);

      const config = opts.config === undefined ? undefined : resolve(cwd, opts.config);
      const plan = await compileOrFail(workflowPath, cwd, config ?? null);
      if (plan === null) return;
      log.debug({ workflow: plan.name, path: workflowPath }, "workflow compiled");

      const prepared = await prepareRun({
        plan,
        workflowPath,
        cwd,
        config: config ?? null,
        inputs: { prompt: opts.prompt, ...opts.input },
        checks: runtimeChecks(plan.agent),
        log: cliLog(),
      });
      if (!prepared.ok) return fail(prepared.error);
      const body = prepared.value;
      await writeProjectTypes(body.cwd, VERSION).catch((error: unknown) =>
        log.warn({ err: error }, "could not write the SDK types to .yok/types"),
      );

      await ensureServer();
      const result = await yokClient().run({
        ...body,
        policies: { workflow: plan.policies, cli: cliPolicies.value },
        ...(opts.name === undefined ? {} : { name: opts.name }),
      });
      if (!result.ok) return fail(apiErrorText(result.error));
      const { run } = result.value;
      const { terminal } = run;
      log.info({ runId: run.id, workflow: run.workflow, cwd: run.cwd, terminal }, "run started");
      await showStartedRun(result.value, opts, cwd, log);
    });
  // one `--NAME <value>` option per policy, with the policy's help text
  for (const name of POLICY_NAMES) {
    command.option(`--${name} <value>`, PoliciesSchema.shape[name].description ?? name);
  }
  return command;
};

export const resumeCommand = () =>
  new Command("resume")
    .description("Bring back a run whose agent session is gone, after a reboot or a crash")
    .argument("[name]", "run name in this repo (default: $YOK_RUN_ID)")
    .option("--run-id <id>", "resume by run id instead of name")
    .option("--no-attach", "do not attach to the session's terminal once it starts")
    .option("--no-open", "do not open the run's page in the browser")
    .action(async (name, opts) => {
      const log = commandLog("resume");
      const registry = createRegistry(registryPath());
      const picked = await requireRun({
        registry,
        name,
        id: opts.runId,
        env: process.env,
        cwd: process.cwd(),
      });
      if (!picked.ok) {
        // A run that died before orchestrate init has no folder to resume from.
        const found = opts.runId === undefined ? undefined : await registry.findRun(opts.runId);
        return fail(
          found?.name === null
            ? `run ${found.id} never started its agent session; start it again with yok run`
            : picked.error,
        );
      }
      const run = picked.value;
      const config = await loadRunConfig(run);
      if (!config.ok) return fail(config.error);
      const plan = await compileRunWorkflow(run, config.value).catch((error: unknown) => {
        fail(errorText(error));
        return null;
      });
      if (plan === null) return;

      // the env every later session of the run gets, from the config init recorded
      const env = await loadEnv(config.value, plan, run.cwd);
      const blocked = await checkBeforeStart(run.cwd, config.value.path ?? undefined, plan, env);
      if (blocked !== null) return fail(blocked);
      if (!env.ok) return fail(env.error);

      await ensureServer();
      const result = await yokClient().resume(run.id, { env: env.value });
      if (!result.ok) return fail(apiErrorText(result.error));
      log.info({ runId: run.id, terminal: result.value.run.terminal }, "run resumed");
      await showStartedRun(result.value, opts, process.cwd(), log);
    });
