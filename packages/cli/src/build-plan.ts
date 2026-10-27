import { Command } from "@commander-js/extra-typings";
import { writePlanPage } from "@yok/core";
import { createRegistryReader, registryPath, requireRun } from "@yok/sdk";
import { fail } from "./client.ts";

export const buildPlanCommand = () =>
  new Command("build-plan")
    .description("Build a run's artifacts/plan.html from its plan.md and phase files")
    .argument("[name]", "run name in this repo (default: $YOK_RUN_ID)")
    .option("--run-id <id>", "build by run id instead of name")
    .action(async (name, opts) => {
      const run = await requireRun({
        registry: createRegistryReader(registryPath()),
        name,
        id: opts.runId,
        env: process.env,
        cwd: process.cwd(),
      });
      if (!run.ok) return fail(run.error);
      try {
        console.log(await writePlanPage(run.value));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
