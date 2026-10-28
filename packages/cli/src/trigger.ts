import { resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { isWorkflowFile, unwrap } from "@yok/core";
import { createGit } from "@yok/sdk";
import type { Fire, Trigger } from "@yok/sdk/internal";
import type { YokClient } from "@yok/server/client";
import { apiErrorText, fail, isRemote, resolveClient } from "./client.ts";
import { PROJECT_REQUIRED } from "./project.ts";
import { pickProjectName, projectAt } from "./run.ts";

// --project names the trigger's project; without it, the project of the checkout this runs in.
// A lookup never adds a project: only `add` does.
const resolveTriggerProject = async (
  client: YokClient,
  project: string | undefined,
): Promise<string> => {
  if (project !== undefined) return project;
  const root = await createGit().repoRoot(process.cwd());
  if (root === null) throw new Error("not inside a git repository; pass --project NAME");
  const known = unwrap(await projectAt(client, root));
  if (known === null) throw new Error(`${root} is not a project; pass --project NAME`);
  return known;
};

export const describeFire = (fire: Fire): string =>
  [
    fire.at,
    fire.status,
    `slot ${fire.slot}`,
    ...(fire.runId === undefined ? [] : [`run ${fire.runId} (${fire.runName ?? "unnamed"})`]),
    ...(fire.reason === undefined ? [] : [fire.reason]),
  ].join("  ");

type Schedule = Pick<Trigger, "name" | "project" | "cron" | "timezone" | "nextFireAt">;

export const describeSchedule = (trigger: Schedule): string => {
  const { name, project, cron, timezone, nextFireAt } = trigger;
  return `${name} in ${project}: ${cron} (${timezone}), next fire ${nextFireAt}`;
};

type ListedTrigger = Schedule & Readonly<{ lastFire: Pick<Fire, "status" | "at"> | null }>;

export const describeTrigger = (t: ListedTrigger): string => {
  const last = t.lastFire === null ? "never fired" : `last ${t.lastFire.status} ${t.lastFire.at}`;
  return `${t.name}  ${t.project}  ${t.cron} (${t.timezone})  next ${t.nextFireAt}  ${last}`;
};

export const triggerCommand = () => {
  const trigger = new Command("trigger").description(
    "Run a workflow on a cron schedule from its trigger: block",
  );

  trigger
    .command("add")
    .argument("<workflow>", "shipped workflow name, or workflow file with a trigger: block")
    .option("--project <name>", "project the runs start in (default: this checkout, added if new)")
    .option("--config <file>", "orchestrate config file the runs read (default: the checkout's)")
    .description("Register the workflow's trigger, or update it if already registered")
    .action(async (workflowArg, opts, command) => {
      const remote = isRemote(command);
      if (remote && opts.project === undefined) return fail(PROJECT_REQUIRED);
      const client = await resolveClient(remote);
      const cwd = process.cwd();
      const root = opts.project === undefined ? await createGit().repoRoot(cwd) : null;
      const project = unwrap(await pickProjectName(client, opts.project, root));
      // A local file goes absolute, as `yok run` sends it; a remote one is sent as typed, and the
      // server resolves both against the project root.
      const absolute = (file: string): string => (remote ? file : resolve(cwd, file));
      const result = await client.addTrigger({
        project,
        workflow: isWorkflowFile(workflowArg) ? absolute(workflowArg) : workflowArg,
        ...(opts.config === undefined ? {} : { config: absolute(opts.config) }),
      });
      if (!result.ok) return fail(apiErrorText(result.error));
      console.log(describeSchedule(result.value.trigger));
    });

  trigger
    .command("list")
    .description("Show every trigger with its next and last fire")
    .action(async (_opts, command) => {
      const client = await resolveClient(isRemote(command));
      const result = await client.listTriggers();
      if (!result.ok) return fail(apiErrorText(result.error));
      for (const t of result.value.triggers) console.log(describeTrigger(t));
    });

  trigger
    .command("fire")
    .argument("<name>", "trigger name: the workflow's name")
    .option("--project <name>", "the trigger's project (default: this checkout's)")
    .description("Fire the trigger now, as its schedule would")
    .action(async (name, opts, command) => {
      const remote = isRemote(command);
      if (remote && opts.project === undefined) return fail(PROJECT_REQUIRED);
      const client = await resolveClient(remote);
      const project = await resolveTriggerProject(client, opts.project);
      const result = await client.fireTrigger({ project, name });
      if (!result.ok) return fail(apiErrorText(result.error));
      const { fire } = result.value;
      if (fire.status === "failed") return fail(describeFire(fire));
      console.log(describeFire(fire));
    });

  trigger
    .command("log")
    .argument("<name>", "trigger name: the workflow's name")
    .option("--project <name>", "the trigger's project (default: this checkout's)")
    .description("Show the trigger's last 20 firings")
    .action(async (name, opts, command) => {
      const remote = isRemote(command);
      if (remote && opts.project === undefined) return fail(PROJECT_REQUIRED);
      const client = await resolveClient(remote);
      const project = await resolveTriggerProject(client, opts.project);
      const result = await client.triggerLog({ project, name });
      if (!result.ok) return fail(apiErrorText(result.error));
      for (const fire of result.value.fires) console.log(describeFire(fire));
    });

  trigger
    .command("rm")
    .argument("<name>", "trigger name: the workflow's name")
    .option("--project <name>", "the trigger's project (default: this checkout's)")
    .description("Stop firing the trigger")
    .action(async (name, opts, command) => {
      const remote = isRemote(command);
      if (remote && opts.project === undefined) return fail(PROJECT_REQUIRED);
      const client = await resolveClient(remote);
      const project = await resolveTriggerProject(client, opts.project);
      const result = await client.removeTrigger({ project, name });
      if (!result.ok) return fail(apiErrorText(result.error));
      console.log(`removed ${name} from ${project}`);
    });

  return trigger;
};
