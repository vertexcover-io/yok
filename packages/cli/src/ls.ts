import { Command } from "@commander-js/extra-typings";
import { renderRuns } from "@yok/server";
import { apiErrorText, fail, isRemote, resolveClient } from "./client.ts";

export const lsCommand = () =>
  new Command("ls")
    .description("List runs, newest first, across every project")
    .option("--limit <n>", "show the newest N runs instead of 20")
    .option("--all", "show every run")
    .option("--project <name>", "show only this project's runs")
    .option("--status <statuses>", "show only runs with these statuses, comma-separated")
    .option(
      "--by <who>",
      "show only runs started by this yok user id, GitHub login, GitHub id or email",
    )
    .option("--json", "print the runs as JSON")
    .action(async ({ limit, all, project, status, by, json }, command) => {
      const client = await resolveClient(isRemote(command));
      const listed = await client.runs({
        ...(project === undefined ? {} : { project }),
        ...(status === undefined ? {} : { status }),
        ...(by === undefined ? {} : { by }),
        ...(limit === undefined ? {} : { limit }),
        ...(all === true ? { all: "true" } : {}),
      });
      if (!listed.ok) return fail(apiErrorText(listed.error));
      if (json === true) return console.log(JSON.stringify(listed.value, null, 2));
      console.log(renderRuns(listed.value, { project, status }, process.stdout.isTTY === true));
    });
