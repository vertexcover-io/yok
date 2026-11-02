import { Command } from "@commander-js/extra-typings";
import { locateWorkflow } from "@yok/core";
import { compileOrFail, fail } from "./client.ts";

export const verifyCommand = () =>
  new Command("verify")
    .description("Compile a workflow and print its compile error, if any")
    .argument("<workflow>", "shipped workflow name, or workflow file to compile")
    .action(async (workflowArg) => {
      const cwd = process.cwd();
      const located = await locateWorkflow(workflowArg, cwd);
      if (!located.ok) return fail(located.error);
      const plan = await compileOrFail(located.value, cwd);
      if (plan === null) return;
      const count = plan.nodes.length;
      console.log(`ok: workflow ${plan.name} compiles (${count} node${count === 1 ? "" : "s"})`);
    });
