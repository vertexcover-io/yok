import { basename, resolve } from "node:path";
import { Command, type CommandUnknownOpts } from "@commander-js/extra-typings";
import {
  builtInChecks,
  compileRunWorkflow,
  type DoctorReport,
  DoctorReportSchema,
  isWorkflowFile,
  runDoctor,
  verdict,
  type WorkflowPlan,
  workflowChecks,
} from "@yok/core";
import {
  createGit,
  type ILogger,
  type JsonObject,
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
import { type ApiError, folderSlug, runtimeChecks } from "@yok/server";
import type { YokClient } from "@yok/server/client";
import {
  apiErrorText,
  cliLog,
  commandLog,
  ensureServer,
  errorText,
  fail,
  isRemote,
  openForPerson,
  resolveClient,
  yokClient,
} from "./client.ts";
import { PROJECT_REQUIRED } from "./project.ts";
import { writeProjectTypes } from "./types.ts";

export const collectInput = (pair: string, acc: Record<string, string>): Record<string, string> => {
  const index = pair.indexOf("=");
  if (index === -1) throw new Error(`--input must be KEY=VALUE, got "${pair}"`);
  return { ...acc, [pair.slice(0, index)]: pair.slice(index + 1) };
};

const blockedText = (message: string, report: DoctorReport): string =>
  [
    message,
    ...report.results
      .filter((row) => row.status === "fail")
      .flatMap((row) => [`${row.name}: ${row.detail}`, ...row.fix.map((step) => `  fix: ${step}`)]),
  ].join("\n");

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
  return verdict(report).startsWith("BLOCKED") ? blockedText(verdict(report), report) : null;
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

export const startError = (error: ApiError): string => {
  const report = DoctorReportSchema.safeParse(error.details);
  return report.success ? blockedText(error.message, report.data) : apiErrorText(error);
};

export const projectAt = async (
  client: YokClient,
  root: string,
): Promise<Result<string | null>> => {
  const listed = await client.projects();
  if (!listed.ok) return { ok: false, error: apiErrorText(listed.error) };
  const known = listed.value.projects.find((project) => project.path === root);
  return { ok: true, value: known?.name ?? null };
};

// The checkout's project, added under its folder's name the first time a run starts in it.
const checkoutProject = async (client: YokClient, root: string): Promise<Result<string>> => {
  const known = await projectAt(client, root);
  if (!known.ok) return known;
  if (known.value !== null) return { ok: true, value: known.value };
  const name = folderSlug(basename(root));
  if (!/^[a-z]/.test(name)) {
    return {
      ok: false,
      error: `cannot name a project from "${basename(root)}"; pass --project NAME`,
    };
  }
  const added = await client.addProject({
    name,
    path: root,
    addedBy: { channel: "cli" },
  });
  if (added.ok) return { ok: true, value: name };
  // Two runs started together in a new checkout both add it; the one that loses uses the other's.
  const raced = await projectAt(client, root);
  if (raced.ok && raced.value !== null) return { ok: true, value: raced.value };
  const hint =
    added.error.code === "conflict"
      ? "; add this checkout under another name with yok project add NAME, then pass --project NAME"
      : "";
  return { ok: false, error: `${apiErrorText(added.error)}${hint}` };
};

// --project names the project; without it, the checkout this command runs in.
export const pickProjectName = async (
  client: YokClient,
  project: string | undefined,
  root: string | null,
): Promise<Result<string>> => {
  if (project !== undefined) return { ok: true, value: project };
  if (root === null) {
    return { ok: false, error: "not inside a git repository; pass --project NAME" };
  }
  return checkoutProject(client, root);
};

type RunOptions = Readonly<{
  prompt: string;
  name?: string;
  project?: string;
  input: Record<string, string>;
  config?: string;
}>;

type RunTarget = Readonly<{ project: string; workflow: string; config?: string }>;

// The checkout's project, added if new, with its .yok/types written. Paths go absolute, which
// the server's resolve against the project root leaves as they are.
const localTarget = async (
  client: YokClient,
  { workflow, opts, cwd }: Readonly<{ workflow: string; opts: RunOptions; cwd: string }>,
): Promise<Result<RunTarget>> => {
  const root = opts.project === undefined ? await createGit().repoRoot(cwd) : null;
  const project = await pickProjectName(client, opts.project, root);
  if (!project.ok) return project;
  // The CLI and the checkout share this machine only when the run is on this checkout.
  if (root !== null) {
    await writeProjectTypes(root, VERSION).catch((error: unknown) =>
      commandLog("run").warn({ err: error }, "could not write the SDK types to .yok/types"),
    );
  }
  const config = opts.config === undefined ? {} : { config: resolve(cwd, opts.config) };
  const path = isWorkflowFile(workflow) ? resolve(cwd, workflow) : workflow;
  return { ok: true, value: { project: project.value, workflow: path, ...config } };
};

// Paths are sent as typed: the server resolves them against its own copy of the project.
const remoteTarget = (workflow: string, opts: RunOptions): Result<RunTarget> => {
  if (opts.project === undefined) return { ok: false, error: PROJECT_REQUIRED };
  const config = opts.config === undefined ? {} : { config: opts.config };
  return { ok: true, value: { project: opts.project, workflow, ...config } };
};

// One `--NAME <value>` option per policy, with its help text, for parsePolicyFlags to read.
export const addPolicyOptions = (command: CommandUnknownOpts): void => {
  for (const name of POLICY_NAMES) {
    command.option(`--${name} <value>`, PoliciesSchema.shape[name].description ?? name);
  }
};

export const runCommand = () => {
  const command = new Command("run")
    .argument("<workflow>", "shipped workflow name (e.g. task), or workflow file to run")
    .requiredOption("--prompt <text>", "first message sent to the agent")
    .option("--name <name>", "run name (default: derived from the prompt)")
    .option(
      "--project <name>",
      "project to run on (default: this checkout, added if new; required with --remote)",
    )
    .option("--input <key=value>", "extra input, repeatable", collectInput, {})
    .option("--no-attach", "do not attach to the session's terminal once it starts")
    .option("--config <file>", "orchestrate config file the run reads (default: the checkout's)")
    .option("--no-open", "do not open the run's page in the browser")
    .action(async (workflowArg, opts, command) => {
      const log = commandLog("run");
      const cwd = process.cwd();
      // the flags are read as YAML and checked, so a bad value fails before anything starts
      const cliPolicies = parsePolicyFlags(opts);
      if (!cliPolicies.ok) return fail(cliPolicies.error);
      const remote = isRemote(command);
      const typed = remote ? remoteTarget(workflowArg, opts) : null;
      if (typed !== null && !typed.ok) return fail(typed.error);
      // Before the project lookup, which calls the server.
      const client = await resolveClient(remote);
      const target = typed ?? (await localTarget(client, { workflow: workflowArg, opts, cwd }));
      if (!target.ok) return fail(target.error);

      const result = await client.run({
        ...target.value,
        inputs: { prompt: opts.prompt, ...opts.input } satisfies JsonObject,
        // Nobody sits at a remote run's terminal, so by default no stage waits for an answer.
        policies: remote ? { interaction: false, ...cliPolicies.value } : cliPolicies.value,
        ...(opts.name === undefined ? {} : { name: opts.name }),
      });
      if (!result.ok) return fail(startError(result.error));
      const { run } = result.value;
      const { terminal } = run;
      log.info({ runId: run.id, workflow: run.workflow, cwd: run.cwd, terminal }, "run started");
      if (remote) return console.log(`${run.id}\nview: ${result.value.view}`);
      await showStartedRun(result.value, opts, cwd, log);
    });
  addPolicyOptions(command);
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
