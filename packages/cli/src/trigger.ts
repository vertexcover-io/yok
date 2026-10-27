import { resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { isWorkflowFile, unwrap } from "@yok/core";
import { createGit } from "@yok/sdk";
import type { Fire } from "@yok/sdk/internal";
import type { YokClient } from "@yok/server/client";
import { apiErrorText, ensureServer, fail, yokClient } from "./client.ts";
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

const describeFire = (fire: Fire): string =>
  [
    fire.at,
    fire.status,
    `slot ${fire.slot}`,
    ...(fire.runId === undefined ? [] : [`run ${fire.runId} (${fire.runName ?? "unnamed"})`]),
    ...(fire.reason === undefined ? [] : [fire.reason]),
  ].join("  ");

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
    .action(async (workflowArg, opts) => {
      await ensureServer();
      const client = yokClient();
      const cwd = process.cwd();
      const root = opts.project === undefined ? await createGit().repoRoot(cwd) : null;
      const project = unwrap(await pickProjectName(client, opts.project, root));
      // A file goes absolute, as `yok run` sends it: the server resolves against the project root.
      const result = await client.addTrigger({
        project,
        workflow: isWorkflowFile(workflowArg) ? resolve(cwd, workflowArg) : workflowArg,
        ...(opts.config === undefined ? {} : { config: resolve(cwd, opts.config) }),
      });
      if (!result.ok) return fail(apiErrorText(result.error));
      const { name, cron, timezone, nextFireAt } = result.value.trigger;
      console.log(`${name} in ${project}: ${cron} (${timezone}), next fire ${nextFireAt}`);
    });

  trigger
    .command("list")
    .description("Show every trigger with its next and last fire")
    .action(async () => {
      await ensureServer();
      const result = await yokClient().listTriggers();
      if (!result.ok) return fail(apiErrorText(result.error));
      for (const t of result.value.triggers) {
        const last =
          t.lastFire === null ? "never fired" : `last ${t.lastFire.status} ${t.lastFire.at}`;
        console.log(
          `${t.name}  ${t.project}  ${t.cron} (${t.timezone})  next ${t.nextFireAt}  ${last}`,
        );
      }
    });

  trigger
    .command("fire")
    .argument("<name>", "trigger name: the workflow's name")
    .option("--project <name>", "the trigger's project (default: this checkout's)")
    .description("Fire the trigger now, as its schedule would")
    .action(async (name, opts) => {
      await ensureServer();
      const client = yokClient();
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
    .action(async (name, opts) => {
      await ensureServer();
      const client = yokClient();
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
    .action(async (name, opts) => {
      await ensureServer();
      const client = yokClient();
      const project = await resolveTriggerProject(client, opts.project);
      const result = await client.removeTrigger({ project, name });
      if (!result.ok) return fail(apiErrorText(result.error));
      console.log(`removed ${name} from ${project}`);
    });

  return trigger;
};
