import { Command } from "@commander-js/extra-typings";
import { yokTerminalHost } from "@yok/core";
import {
  closingLine,
  type Result,
  readState,
  registryPath,
  requireRun,
  runDirOf,
  spawnInteractive,
  type WorkflowRun,
} from "@yok/sdk";
import { createRegistry, isRunLive, type Registry } from "@yok/sdk/internal";
import { commandLog, fail } from "./client.ts";

const findById = async (registry: Registry, id: string): Promise<Result<WorkflowRun>> => {
  const run = await registry.findRun(id);
  return run === undefined ? { ok: false, error: `run ${id} not found` } : { ok: true, value: run };
};

// An id on its own is looked up as is, so a run can be attached before init names it. A name, or
// $YOK_RUN_ID, goes through requireRun, the way orchestrate picks a run.
const findRunToAttach = async (
  registry: Registry,
  name: string | undefined,
  runId: string | undefined,
): Promise<Result<WorkflowRun>> => {
  if (runId !== undefined && name === undefined) return findById(registry, runId);
  const picked = await requireRun({
    registry,
    name,
    id: runId,
    env: process.env,
    cwd: process.cwd(),
  });
  return picked.ok ? findById(registry, picked.value.id) : picked;
};

// The session is gone: a finished run says how it ended, any other run how to bring it back.
// readState throws on a broken state.json; that run is treated as one still going.
const goneMessage = async (run: WorkflowRun): Promise<string> => {
  const name = run.name ?? run.id;
  const state =
    run.name === null ? null : await readState(runDirOf(run.cwd, run.name)).catch(() => null);
  if (state !== null && !isRunLive(state.status)) return closingLine(name, state.status);
  return `Run ${name} has no running session. Resume it with: yok resume ${name}`;
};

const attachArgv = async (run: WorkflowRun): Promise<Result<readonly string[]>> => {
  if (run.terminal === null) return { ok: false, error: `run ${run.id} has no terminal yet` };
  const terminal = yokTerminalHost().find(run.terminal);
  if (await terminal.isAlive()) return { ok: true, value: terminal.attachCommand() };
  return { ok: false, error: await goneMessage(run) };
};

export const attachCommand = () =>
  new Command("attach")
    .description("Attach to a run's terminal")
    .argument("[name]", "run name in this repo (default: $YOK_RUN_ID)")
    .option("--run-id <id>", "attach by run id instead of name")
    .option("--print", "print the attach command instead of running it")
    .action(async (name, opts) => {
      const run = await findRunToAttach(createRegistry(registryPath()), name, opts.runId);
      if (!run.ok) return fail(run.error);
      const argv = await attachArgv(run.value);
      if (!argv.ok) return fail(argv.error);
      if (opts.print === true) {
        console.log(argv.value.join(" "));
        return;
      }
      const [command, ...args] = argv.value;
      const exitCode = await spawnInteractive(command as string, args, {
        cwd: process.cwd(),
        env: { TMUX: undefined },
      });
      commandLog("attach").info({ runId: run.value.id, exitCode }, "detached from the session");
      process.exitCode = exitCode;
    });
