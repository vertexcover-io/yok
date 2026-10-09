import { Command, InvalidArgumentError, Option } from "@commander-js/extra-typings";
import { agentBinary, installPlugin, type WorkflowAgent, WorkflowAgentSchema } from "@yok/core";
import { execWithTimeout } from "@yok/sdk";
import { isCompiled, VERSION } from "@yok/sdk/internal";
import { fail } from "./client.ts";

// The custom parser replaces the one `.choices()` installs, so it validates the value itself.
const parseAgent = (
  value: string,
  previous: readonly WorkflowAgent[] = [],
): readonly WorkflowAgent[] => {
  const agent = WorkflowAgentSchema.safeParse(value);
  if (!agent.success) {
    throw new InvalidArgumentError(
      `expected ${WorkflowAgentSchema.options.join(" or ")}, got ${value}`,
    );
  }
  return [...previous, agent.data];
};

export const agentOption = () =>
  new Option("--agent <name>", "claude or codex; repeat for both")
    .argParser(parseAgent)
    .makeOptionMandatory();

const DEV_PLUGIN = "yok-dev loads the plugin from this checkout: claude --plugin-dir PATH_TO_REPO";

const installAll = async (agents: readonly WorkflowAgent[]): Promise<void> => {
  for (const agent of agents) {
    const binary = agentBinary(agent, process.env);
    const exec = execWithTimeout(120_000);
    const result = await installPlugin(agent, binary, VERSION, exec, process.cwd());
    if (!result.ok) return fail(result.error);
    console.log(result.value);
  }
};

export const pluginCommand = () =>
  new Command("plugin").description("Manage the yok agent plugin").addCommand(
    new Command("install")
      .description("Install the plugin at this binary's version, or move an installed one to it")
      .addOption(agentOption())
      .action(async ({ agent }) => (isCompiled ? installAll(agent) : fail(DEV_PLUGIN))),
  );
