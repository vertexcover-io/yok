import { type Check, type Exec, fail, ok, type Result } from "@yok/sdk";
import { isCompiled } from "@yok/sdk/internal";
import * as z from "zod";
import type { WorkflowAgent } from "./workflow/types.ts";

export const YOK_REPO = "vertexcover-io/yok";

const ClaudePluginsSchema = z.array(
  z.object({
    id: z.string(),
    version: z.string(),
    enabled: z.boolean(),
    scope: z.string(),
    projectPath: z.string().optional(),
  }),
);

const CodexPluginsSchema = z.object({
  installed: z.array(
    z.object({
      name: z.string(),
      marketplaceName: z.string(),
      version: z.string(),
      enabled: z.boolean(),
    }),
  ),
});

const ClaudeMarketplacesSchema = z.array(
  z.object({ name: z.string(), repo: z.string().optional(), url: z.string().optional() }),
);

const CodexMarketplacesSchema = z.object({
  marketplaces: z.array(
    z.object({
      name: z.string(),
      marketplaceSource: z.object({ source: z.string() }).optional(),
    }),
  ),
});

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

// A project or local install counts only inside its own project.
export const enabledVersions = (
  agent: WorkflowAgent,
  listJson: string,
  root: string,
): readonly string[] => {
  const json: unknown = JSON.parse(listJson);
  if (agent === "codex") {
    return CodexPluginsSchema.parse(json)
      .installed.filter((p) => p.enabled && p.name === "yok" && p.marketplaceName === "yok")
      .map((p) => p.version);
  }
  return ClaudePluginsSchema.parse(json)
    .filter((p) => p.enabled && p.id === "yok@yok")
    .filter((p) => p.projectPath === undefined || p.projectPath === root)
    .map((p) => p.version);
};

const installFix = (agent: WorkflowAgent): string => `yok plugin install --agent ${agent}`;

export const pluginCheck = (
  agent: WorkflowAgent,
  binary: string,
  version: string,
  compiled = isCompiled,
): Check => ({
  name: `${agent}-plugin`,
  fix: [installFix(agent)],
  run: async ({ root, exec }) => {
    if (!compiled) return ok("dev: skills come from this checkout");
    const listed = await exec(binary, ["plugin", "list", "--json"], root);
    if (listed.code !== 0) return fail(`${agent} plugin list failed: ${firstLine(listed.stderr)}`);
    const versions = enabledVersions(agent, listed.stdout, root);
    if (versions.length === 0) return fail(`the yok plugin is not installed for ${agent}`);
    const other = versions.find((enabled) => enabled !== version);
    if (other === undefined) return ok(`yok ${version}`);
    return fail(`${agent} has yok ${other}; this binary is ${version}`, [
      installFix(agent),
      `yok update --agent ${agent}`,
    ]);
  },
});

// undefined: no marketplace named yok; null: one exists but records no source.
const marketplaceSource = (agent: WorkflowAgent, listJson: string): string | null | undefined => {
  const json: unknown = JSON.parse(listJson);
  if (agent === "codex") {
    const found = CodexMarketplacesSchema.parse(json).marketplaces.find((m) => m.name === "yok");
    return found === undefined ? undefined : (found.marketplaceSource?.source ?? null);
  }
  const found = ClaudeMarketplacesSchema.parse(json).find((m) => m.name === "yok");
  return found === undefined ? undefined : (found.repo ?? found.url ?? null);
};

const addAndInstall = (agent: WorkflowAgent, tag: string): readonly (readonly string[])[] =>
  agent === "claude"
    ? [
        ["plugin", "marketplace", "add", `${YOK_REPO}#${tag}`],
        ["plugin", "install", "yok@yok"],
      ]
    : [
        ["plugin", "marketplace", "add", YOK_REPO, "--ref", tag],
        ["plugin", "add", "yok", "--marketplace", "yok"],
      ];

// owner/repo, a GitHub HTTPS or SSH URL, with an optional .git and #ref. Anything else, such as a
// fork or another host, is not this repo.
const GITHUB_SOURCE =
  /^(?:https:\/\/github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?(?:#.*)?$/;

const isYokRepo = (source: string): boolean =>
  GITHUB_SOURCE.exec(source)?.[1]?.toLowerCase() === YOK_REPO;

type Run = (args: readonly string[]) => Promise<Result<string, string>>;

const runner =
  (binary: string, exec: Exec, cwd: string): Run =>
  async (args) => {
    const result = await exec(binary, args, cwd);
    return result.code === 0
      ? { ok: true, value: result.stdout }
      : { ok: false, error: `${binary} ${args.join(" ")} failed: ${firstLine(result.stderr)}` };
  };

// Returns whether this repo's marketplace is present. A source that cannot be identified may be
// another team's marketplace, so it is an error and never removed.
const ownMarketplace = async (agent: WorkflowAgent, run: Run): Promise<Result<boolean, string>> => {
  const markets = await run(["plugin", "marketplace", "list", "--json"]);
  if (!markets.ok) return markets;
  const source = marketplaceSource(agent, markets.value);
  if (source === undefined) return { ok: true, value: false };
  if (source === null || !isYokRepo(source)) {
    return { ok: false, error: `a marketplace named yok points at ${source}; remove it first` };
  }
  return { ok: true, value: true };
};

// An added marketplace's source cannot change and the plugin version comes from the tag it was
// added at, so moving to another version removes this repo's marketplace and adds it again.
export const installPlugin = async (
  agent: WorkflowAgent,
  binary: string,
  version: string,
  exec: Exec,
  cwd: string,
): Promise<Result<string, string>> => {
  const run = runner(binary, exec, cwd);
  const listed = await run(["plugin", "list", "--json"]);
  if (!listed.ok) return listed;
  const versions = enabledVersions(agent, listed.value, cwd);
  if (versions.length > 0 && versions.every((v) => v === version)) {
    return { ok: true, value: `yok ${version} is already installed for ${agent}` };
  }
  const own = await ownMarketplace(agent, run);
  if (!own.ok) return own;
  if (own.value) {
    const removed = await run(["plugin", "marketplace", "remove", "yok"]);
    if (!removed.ok) return removed;
  }
  for (const args of addAndInstall(agent, `v${version}`)) {
    const step = await run(args);
    if (!step.ok) return step;
  }
  return {
    ok: true,
    value: `installed yok ${version} for ${agent}; running sessions keep the old skills until /reload-plugins or a restart`,
  };
};

const isInstalled = (agent: WorkflowAgent, listJson: string): boolean => {
  const json: unknown = JSON.parse(listJson);
  if (agent === "codex") {
    return CodexPluginsSchema.parse(json).installed.some(
      (p) => p.name === "yok" && p.marketplaceName === "yok",
    );
  }
  return ClaudePluginsSchema.parse(json).some((p) => p.id === "yok@yok" && p.scope === "user");
};

const removeCommand = (agent: WorkflowAgent): readonly string[] =>
  agent === "claude" ? ["plugin", "uninstall", "yok@yok"] : ["plugin", "remove", "yok@yok"];

// The marketplace is checked first, so a yok plugin from someone else's marketplace stays.
export const uninstallPlugin = async (
  agent: WorkflowAgent,
  binary: string,
  exec: Exec,
  cwd: string,
): Promise<Result<string, string>> => {
  const run = runner(binary, exec, cwd);
  const own = await ownMarketplace(agent, run);
  if (!own.ok) return own;
  const listed = await run(["plugin", "list", "--json"]);
  if (!listed.ok) return listed;
  const installed = isInstalled(agent, listed.value);
  if (!installed && !own.value) return { ok: true, value: `${agent} has no yok plugin` };
  if (installed) {
    const removed = await run(removeCommand(agent));
    if (!removed.ok) return removed;
  }
  if (own.value) {
    const removed = await run(["plugin", "marketplace", "remove", "yok"]);
    if (!removed.ok) return removed;
  }
  return { ok: true, value: `removed the yok plugin from ${agent}` };
};
