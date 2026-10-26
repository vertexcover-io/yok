import { Command, InvalidArgumentError, Option } from "@commander-js/extra-typings";
import { agentBinary, installPlugin, type WorkflowAgent, WorkflowAgentSchema } from "@yok/core";
import { execWithTimeout, type Result } from "@yok/sdk";
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

export const agentOption = (description: string) =>
  new Option("--agent <name>", description).argParser(parseAgent);

const DEV_PLUGIN = "yok-dev loads the plugin from this checkout: claude --plugin-dir PATH_TO_REPO";

type Env = Readonly<Record<string, string | undefined>>;

// An agent counts as installed when its CLI is on PATH.
export const agentsOnPath = (env: Env): readonly WorkflowAgent[] =>
  WorkflowAgentSchema.options.filter(
    (agent) => Bun.which(agentBinary(agent, env), { PATH: env.PATH ?? "" }) !== null,
  );

// No agent to move would leave the new binary without a matching plugin, so nothing runs.
export const updateAgents = (
  named: readonly WorkflowAgent[] | undefined,
  env: Env,
): Result<readonly WorkflowAgent[]> => {
  if (named !== undefined) return { ok: true, value: named };
  const found = agentsOnPath(env);
  if (found.length > 0) return { ok: true, value: found };
  return {
    ok: false,
    error: "found neither claude nor codex on PATH: install one, or name it with --agent",
  };
};

// installPlugin also throws: on a timeout, or on agent output it cannot parse.
const tryInstall = async (agent: WorkflowAgent, env: Env): Promise<Result<string, string>> => {
  const binary = agentBinary(agent, env);
  try {
    return await installPlugin(agent, binary, VERSION, execWithTimeout(120_000), process.cwd());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${binary} plugin install failed: ${message}` };
  }
};

// Every agent is tried, so one broken agent does not keep the others on the old plugin.
export const installAll = async (agents: readonly WorkflowAgent[], env: Env): Promise<number> => {
  const failed: WorkflowAgent[] = [];
  for (const agent of agents) {
    const result = await tryInstall(agent, env);
    if (result.ok) {
      console.log(result.value);
      continue;
    }
    console.error(result.error);
    failed.push(agent);
  }
  if (failed.length === 0) return 0;
  if (agents.length > 1) {
    console.error(
      `the yok plugin did not move for ${failed.join(" and ")}: limit it with --agent NAME`,
    );
  }
  return 1;
};

// A bare call that finds no agent is not a failure: install.sh runs it on every machine, and a
// binary without an agent is still a working install.
export const installPlugins = async (
  named: readonly WorkflowAgent[] | undefined,
  env: Env,
): Promise<number> => {
  const agents = named ?? agentsOnPath(env);
  if (agents.length > 0) return installAll(agents, env);
  console.log("No claude or codex found. Install one, then run: yok plugin install");
  return 0;
};

export const pluginCommand = () =>
  new Command("plugin").description("Manage the yok agent plugin").addCommand(
    new Command("install")
      .description("Install the plugin at this binary's version, or move an installed one to it")
      .addOption(agentOption("claude or codex; repeat for both; default: every one found on PATH"))
      .action(async ({ agent }) => {
        if (!isCompiled) return fail(DEV_PLUGIN);
        process.exitCode = await installPlugins(agent, process.env);
      }),
  );
