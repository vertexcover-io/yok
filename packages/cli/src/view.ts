import { Command } from "@commander-js/extra-typings";
import { createRegistryReader, pickRun, registryPath } from "@yok/sdk";
import { apiErrorText, ensureServer, fail, openForPerson, remoteUrl, yokClient } from "./client.ts";

export const viewCommand = () =>
  new Command("view")
    .description("Open a run's page, or the list of every run, in the browser")
    .argument("[name]", "run name in this repo (default: $YOK_RUN_ID, else the list of runs)")
    .option("--run-id <id>", "view by run id instead of name")
    .option("--print", "print the page URL without opening it")
    .action(async (name, opts) => {
      // pickRun reads this machine's registry, which a remote server's runs are not in.
      if (remoteUrl() !== null) {
        return fail("yok view works with the local server only; open the view URL yok run printed");
      }
      const run = await pickRun({
        registry: createRegistryReader(registryPath()),
        name,
        id: opts.runId,
        env: process.env,
        cwd: process.cwd(),
      });
      if (!run.ok) return fail(run.error);
      await ensureServer();
      const client = yokClient();
      const reply = await (run.value === undefined ? client.viewRuns() : client.view(run.value.id));
      if (!reply.ok) return fail(apiErrorText(reply.error));
      console.log(reply.value.view);
      openForPerson(reply.value.view, opts.print === true);
    });
