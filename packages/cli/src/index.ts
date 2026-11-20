#!/usr/bin/env -S bun --no-env-file
import { Command } from "@commander-js/extra-typings";
import { orchestrateCommand } from "@yok/core";
import { checkSqliteVersion, isCompiled, sqliteVersion, VERSION } from "@yok/sdk/internal";
import { agentCommand } from "./agent.ts";
import { attachCommand } from "./attach.ts";
import { buildPlanCommand } from "./build-plan.ts";
import { checkRemoteFlag, commandPath, fail } from "./client.ts";
import { doctorCommand } from "./doctor.ts";
import { importFilesCommand } from "./import-files.ts";
import { uninstallCommand, updateCommand } from "./install.ts";
import { loginCommand } from "./login.ts";
import { lsCommand } from "./ls.ts";
import { pluginCommand } from "./plugin.ts";
import { projectCommand } from "./project.ts";
import { rmCommand } from "./rm.ts";
import { resumeCommand, retryCommand, runCommand } from "./run.ts";
import { serveModules } from "./serve.ts";
import { serverCommand } from "./server.ts";
import { triggerCommand } from "./trigger.ts";
import { typesCommand } from "./types.ts";
import { verifyCommand } from "./verify.ts";
import { viewCommand } from "./view.ts";

// How to start this program again, for every self-call and every child that makes one.
process.env.YOK_SELF = JSON.stringify(
  isCompiled ? [process.execPath] : [process.execPath, "--no-env-file", import.meta.path],
);

// Before any command runs, so every module it loads gets the served imports.
serveModules();

// Positional options stop the root reading flags after the command name, so --remote is moved to
// the front: the same answer wherever it is typed.
const [runtime = "", script = "", ...rest] = process.argv;
const remote = rest.includes("--remote") ? ["--remote"] : [];
const argv = [runtime, script, ...remote, ...rest.filter((arg) => arg !== "--remote")];

// For install.sh: a binary this machine's SQLite cannot run is never put in place.
const sqliteCheckCommand = () =>
  new Command("sqlite-check")
    .description("Exit 0 when this machine's SQLite is new enough for yok.db")
    .action(() => {
      const checked = checkSqliteVersion(sqliteVersion());
      if (!checked.ok) fail(checked.error);
    });

await new Command()
  .name("yok")
  .description("Yok engineering CLI")
  .version(VERSION)
  .enablePositionalOptions()
  .option("--remote", "act on the server saved by yok-remote login instead of this machine")
  .hook("preAction", (root, action) =>
    checkRemoteFlag(root.opts().remote === true, commandPath(action)),
  )
  .addCommand(attachCommand())
  .addCommand(buildPlanCommand())
  .addCommand(agentCommand("claude"))
  .addCommand(agentCommand("codex"))
  .addCommand(doctorCommand())
  .addCommand(loginCommand())
  .addCommand(lsCommand())
  .addCommand(orchestrateCommand())
  .addCommand(pluginCommand())
  .addCommand(projectCommand())
  .addCommand(runCommand())
  .addCommand(resumeCommand())
  .addCommand(retryCommand())
  .addCommand(rmCommand())
  .addCommand(serverCommand())
  .addCommand(triggerCommand())
  .addCommand(typesCommand())
  .addCommand(uninstallCommand())
  .addCommand(updateCommand())
  .addCommand(verifyCommand())
  .addCommand(viewCommand())
  .addCommand(sqliteCheckCommand(), { hidden: true })
  .addCommand(importFilesCommand(), { hidden: true })
  .parseAsync(argv)
  .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
