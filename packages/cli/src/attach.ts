import { Command } from "@commander-js/extra-typings";
import { yokTerminalHost } from "@yok/core";
import {
  findRunPane,
  type IStorage,
  type Result,
  requireRun,
  spawnInteractive,
  type WorkflowRun,
  yokHome,
} from "@yok/sdk";
import { withStorage } from "@yok/sdk/internal";
import { commandLog, fail } from "./client.ts";

const findById = async (storage: IStorage, id: string): Promise<Result<WorkflowRun>> => {
  const run = await storage.runs.findRun(id);
  return run === undefined ? { ok: false, error: `run ${id} not found` } : { ok: true, value: run };
};

// An id on its own is looked up as is, so a run can be attached before init names it. A name, or
// $YOK_RUN_ID, goes through requireRun, the way orchestrate picks a run.
const findRunToAttach = async (
  storage: IStorage,
  name: string | undefined,
  runId: string | undefined,
): Promise<Result<WorkflowRun>> => {
  if (runId !== undefined && name === undefined) return findById(storage, runId);
  const picked = await requireRun({
    storage,
    name,
    id: runId,
    env: process.env,
    cwd: process.cwd(),
  });
  return picked.ok ? findById(storage, picked.value.id) : picked;
};

type Attach = Readonly<{ run: WorkflowRun; argv: readonly string[] }>;

const findAttach = async (
  storage: IStorage,
  name: string | undefined,
  runId: string | undefined,
): Promise<Result<Attach>> => {
  const run = await findRunToAttach(storage, name, runId);
  if (!run.ok) return run;
  const pane = await findRunPane(yokTerminalHost(), run.value, storage);
  return pane.ok ? { ok: true, value: { run: run.value, argv: pane.value.attachCommand() } } : pane;
};

export const attachCommand = () =>
  new Command("attach")
    .description("Attach to a run's terminal")
    .argument("[name]", "run name in this repo (default: $YOK_RUN_ID)")
    .option("--run-id <id>", "attach by run id instead of name")
    .option("--print", "print the attach command instead of running it")
    .action(async (name, opts) => {
      // Closed before the session takes the terminal, so a long attach holds no database handle.
      const found = await withStorage(yokHome(), (storage) =>
        findAttach(storage, name, opts.runId),
      );
      if (!found.ok) return fail(found.error);
      const { run, argv } = found.value;
      if (opts.print === true) {
        console.log(argv.join(" "));
        return;
      }
      const [command, ...args] = argv;
      const exitCode = await spawnInteractive(command as string, args, {
        cwd: process.cwd(),
        env: { TMUX: undefined },
      });
      commandLog("attach").info({ runId: run.id, exitCode }, "detached from the session");
      process.exitCode = exitCode;
    });
