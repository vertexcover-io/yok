import { resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { findWorkflowPath } from "@yok/core";
import { createGit } from "@yok/sdk";
import type { Fire } from "@yok/sdk/internal";
import { apiErrorText, ensureServer, fail, yokClient } from "./client.ts";

// A trigger belongs to the repo it was added from, and its runs start at that repo's root.
const repoRootOrFail = async (): Promise<string | null> => {
  const root = await createGit().repoRoot(process.cwd());
  if (root === null) fail("not inside a git repository");
  return root;
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
    .argument("<workflow>", "workflow file with a trigger: block")
    .option("--config <file>", "orchestrate config file the runs read (default: the checkout's)")
    .description("Register the workflow's trigger, or update it if already registered")
    .action(async (workflowArg, opts) => {
      const cwd = await repoRootOrFail();
      if (cwd === null) return;
      await ensureServer();
      const result = await yokClient().addTrigger({
        workflowPath: findWorkflowPath(workflowArg, process.cwd()),
        cwd,
        ...(opts.config === undefined ? {} : { config: resolve(process.cwd(), opts.config) }),
      });
      if (!result.ok) return fail(apiErrorText(result.error));
      const { name, cron, timezone, nextFireAt } = result.value.trigger;
      console.log(`${name}: ${cron} (${timezone}), next fire ${nextFireAt}`);
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
          `${t.name}  ${t.cron} (${t.timezone})  next ${t.nextFireAt}  ${last}  ${t.cwd}`,
        );
      }
    });

  trigger
    .command("fire")
    .argument("<name>", "trigger name: the workflow's name")
    .description("Fire the trigger now, as its schedule would")
    .action(async (name) => {
      const cwd = await repoRootOrFail();
      if (cwd === null) return;
      await ensureServer();
      const result = await yokClient().fireTrigger({ cwd, name });
      if (!result.ok) return fail(apiErrorText(result.error));
      const { fire } = result.value;
      if (fire.status === "failed") return fail(describeFire(fire));
      console.log(describeFire(fire));
    });

  trigger
    .command("log")
    .argument("<name>", "trigger name: the workflow's name")
    .description("Show the trigger's last 20 firings")
    .action(async (name) => {
      const cwd = await repoRootOrFail();
      if (cwd === null) return;
      await ensureServer();
      const result = await yokClient().triggerLog({ cwd, name });
      if (!result.ok) return fail(apiErrorText(result.error));
      for (const fire of result.value.fires) console.log(describeFire(fire));
    });

  trigger
    .command("rm")
    .argument("<name>", "trigger name: the workflow's name")
    .description("Stop firing the trigger")
    .action(async (name) => {
      const cwd = await repoRootOrFail();
      if (cwd === null) return;
      await ensureServer();
      const result = await yokClient().removeTrigger({ cwd, name });
      if (!result.ok) return fail(apiErrorText(result.error));
      console.log(`removed ${name}`);
    });

  return trigger;
};
