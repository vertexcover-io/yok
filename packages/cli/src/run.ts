import { basename, resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { type DoctorReport, isWorkflowFile } from "@yok/core";
import { createGit, type JsonObject, type Result, spawnInteractive } from "@yok/sdk";
import { isCompiled, VERSION } from "@yok/sdk/internal";
import type { ApiError } from "@yok/server";
import type { YokClient } from "@yok/server/client";
import {
  apiErrorText,
  commandLog,
  ensureServer,
  fail,
  openForPerson,
  remoteUrl,
  yokClient,
} from "./client.ts";
import { folderSlug } from "./project.ts";
import { writeProjectTypes } from "./types.ts";

const collectInput = (pair: string, acc: Record<string, string>): Record<string, string> => {
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

const startError = (error: ApiError): string =>
  error.findings === undefined ? apiErrorText(error) : blockedText(error.message, error.findings);

const projectAt = async (client: YokClient, root: string): Promise<Result<string | null>> => {
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
  const added = await client.addProject({ name, path: root, addedBy: { channel: "cli" } });
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
const pickProjectName = async (
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

type RunTarget = Readonly<{ project?: string; workflow: string; config?: string }>;

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

// The current folder is on another machine: no checkout to add, no .yok/types to write, and the
// workflow and config go as typed, for the server to resolve against the project's root.
const remoteTarget = (workflow: string, opts: RunOptions): RunTarget => ({
  workflow,
  ...(opts.project === undefined ? {} : { project: opts.project }),
  ...(opts.config === undefined ? {} : { config: opts.config }),
});

export const runCommand = () =>
  new Command("run")
    .argument("<workflow>", "shipped workflow name (e.g. task), or workflow file to run")
    .requiredOption("--prompt <text>", "first message sent to the agent")
    .option("--name <name>", "run name (default: derived from the prompt)")
    .option("--project <name>", "project to run on (default: this checkout, added if new)")
    .option("--input <key=value>", "extra input, repeatable", collectInput, {})
    .option("--no-attach", "do not attach to the session's terminal once it starts")
    .option("--config <file>", "orchestrate config file the run reads (default: the checkout's)")
    .option("--no-open", "do not open the run's page in the browser")
    .action(async (workflowArg, opts) => {
      const log = commandLog("run");
      const cwd = process.cwd();
      // Before the project lookup, which calls the server.
      await ensureServer();
      const client = yokClient();
      const remote = remoteUrl() !== null;
      const target = remote
        ? { ok: true as const, value: remoteTarget(workflowArg, opts) }
        : await localTarget(client, { workflow: workflowArg, opts, cwd });
      if (!target.ok) return fail(target.error);

      const result = await client.run({
        ...target.value,
        inputs: { prompt: opts.prompt, ...opts.input } satisfies JsonObject,
        ...(opts.name === undefined ? {} : { name: opts.name }),
      });
      if (!result.ok) return fail(startError(result.error));
      const { run } = result.value;
      console.log(run.id);
      // Attach and the browser need the server's machine, so a remote run prints its page only.
      if (remote) return console.log(`view: ${result.value.view}`);
      const { terminal } = run;
      log.info({ runId: run.id, workflow: run.workflow, cwd: run.cwd, terminal }, "run started");

      console.log(`${isCompiled ? "yok" : "yok-dev"} attach --run-id ${run.id}`);
      console.log(`view: ${result.value.view}`);
      openForPerson(result.value.view, opts.open === false);

      // A script, CI job or test has no terminal for tmux to attach to.
      const hasTerminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
      if (opts.attach && hasTerminal) {
        const [command, ...args] = result.value.attach;
        // Without TMUX, the attach also works from inside the user's own tmux.
        const exitCode = await spawnInteractive(command as string, args, {
          cwd,
          env: { TMUX: undefined },
        });
        log.info({ runId: run.id, terminal, exitCode }, "detached from the session");
        process.exitCode = exitCode;
      }
    });
