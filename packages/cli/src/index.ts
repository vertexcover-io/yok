#!/usr/bin/env -S bun --no-env-file
import { Command } from "@commander-js/extra-typings";
import { orchestrateCommand } from "@yok/core";
import { isCompiled, VERSION } from "@yok/sdk/internal";
import { agentCommand } from "./agent.ts";
import { attachCommand } from "./attach.ts";
import { buildPlanCommand } from "./build-plan.ts";
import { checkRemoteFlag, commandPath, fail } from "./client.ts";
import { doctorCommand } from "./doctor.ts";
import { uninstallCommand, updateCommand } from "./install.ts";
import { loginCommand } from "./login.ts";
import { pluginCommand } from "./plugin.ts";
import { projectCommand } from "./project.ts";
import { resumeCommand, runCommand } from "./run.ts";
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
  .addCommand(orchestrateCommand())
  .addCommand(pluginCommand())
  .addCommand(projectCommand())
  .addCommand(runCommand())
  .addCommand(resumeCommand())
  .addCommand(serverCommand())
  .addCommand(triggerCommand())
  .addCommand(typesCommand())
  .addCommand(uninstallCommand())
  .addCommand(updateCommand())
  .addCommand(verifyCommand())
  .addCommand(viewCommand())
  .parseAsync(argv)
  .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
