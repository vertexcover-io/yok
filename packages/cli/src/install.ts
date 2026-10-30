import { existsSync, realpathSync } from "node:fs";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "@commander-js/extra-typings";
import { agentBinary, uninstallPlugin, type WorkflowAgent, YOK_REPO } from "@yok/core";
import { execWithTimeout, type Result, spawnInteractive, yokHome } from "@yok/sdk";
import { isCompiled, VERSION } from "@yok/sdk/internal";
import * as z from "zod";
import { fail, restartServer, runningServer, stopServer } from "./client.ts";
import {
  agentOption,
  agentsOnPath,
  installedBy,
  type PackageManager,
  updateAgents,
} from "./plugin.ts";

const PLATFORMS: Readonly<Record<string, string>> = { darwin: "darwin", linux: "linux" };
const ARCHES: Readonly<Record<string, string>> = { arm64: "arm64", x64: "x64" };

export const assetName = (platform: string, arch: string): string => {
  const os = PLATFORMS[platform];
  const cpu = ARCHES[arch];
  if (os === undefined || cpu === undefined) {
    throw new Error(`no yok build for ${platform}-${arch}`);
  }
  return `yok-${os}-${cpu}`;
};

const ReleasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(z.object({ name: z.string(), url: z.string() })),
  }),
);
type Releases = z.infer<typeof ReleasesSchema>;

// GitHub lists releases newest first, so the first match is the newest.
export const pickRelease = (
  releasesJson: unknown,
  asset: string,
  preRelease: boolean,
): string | null =>
  ReleasesSchema.parse(releasesJson).find(
    (r) => !r.draft && (preRelease || !r.prerelease) && r.assets.some((a) => a.name === asset),
  )?.tag_name ?? null;

// checksums.txt is `shasum -a 256` output: "HASH  NAME" per line.
export const checksumFor = (checksums: string, asset: string): string | null =>
  checksums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0] ?? null;

const DEV_UPDATE = "yok-dev is this checkout: run git pull";

export type ManagedUpdate = Readonly<{ upgrade: readonly [string, ...string[]]; binary: string }>;

// binary is the path that holds the upgraded yok. Homebrew removes the old version's Cellar
// folder, so its opt link is the path that follows the upgrade; npm replaces the file in place.
export const managedUpdate = (
  manager: PackageManager,
  execPath: string,
  preRelease: boolean,
): Result<ManagedUpdate> => {
  if (manager === "npm") {
    const tag = preRelease ? "next" : "latest";
    const upgrade = ["npm", "install", "-g", `@vertexcover/yok@${tag}`] as const;
    return { ok: true, value: { upgrade, binary: execPath } };
  }
  if (preRelease) {
    return {
      ok: false,
      error: "Homebrew ships stable releases only: drop --pre-release, or install yok with npm",
    };
  }
  const prefix = execPath.slice(0, execPath.indexOf("/Cellar/yok/"));
  return {
    ok: true,
    value: { upgrade: ["brew", "upgrade", "yok"], binary: `${prefix}/opt/yok/bin/yok` },
  };
};

const MANAGED_UNINSTALL: Readonly<Record<PackageManager, string>> = {
  homebrew: "brew uninstall yok",
  npm: "npm rm -g @vertexcover/yok",
};

// Homebrew links bin/yok to its Cellar, so the real path is the one that names the manager.
const realExecPath = (): string => realpathSync(process.execPath);
const DEV_UNINSTALL = "yok-dev is this checkout: there is nothing to uninstall";

const ghAuthToken = (): string | null => {
  const result = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
  return result.success ? result.stdout.toString() : null;
};

// The repo is private, so every API call needs a token from someone who can see it.
export const githubToken = (
  env: Readonly<Record<string, string | undefined>>,
  gh: () => string | null = ghAuthToken,
): string | null => {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || gh()?.trim();
  return token ? token : null;
};

const authorization = (token: string | null): Record<string, string> =>
  token === null ? {} : { Authorization: `Bearer ${token}` };

// An asset's API URL redirects to storage that rejects a second credential, so the token goes
// only to the API and the redirect is followed without it.
const download = async (url: string, token: string | null): Promise<Uint8Array> => {
  const headers = { ...authorization(token), Accept: "application/octet-stream" };
  const first = await fetch(url, { headers, redirect: "manual" });
  const location = first.headers.get("location");
  const response =
    first.status >= 300 && first.status < 400 && location ? await fetch(location) : first;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export type UpdateTarget = Readonly<{
  execPath: string;
  releasesUrl: string;
  token: string | null;
  version: string;
}>;

type ReleaseSource = Omit<UpdateTarget, "token">;

const RELEASES_URL = `https://api.github.com/repos/${YOK_REPO}/releases?per_page=30`;

const NO_ACCESS = `yok is private: run gh auth login with an account that can see ${YOK_REPO}, or set GH_TOKEN`;

const assetUrl = (releases: Releases, tag: string, name: string): string => {
  const url = releases.find((r) => r.tag_name === tag)?.assets.find((a) => a.name === name)?.url;
  if (url === undefined) throw new Error(`release ${tag} has no ${name}`);
  return url;
};

// Returns the problem, or null once the new binary is in place. Nothing is written on a mismatch.
const replaceBinary = async (
  target: UpdateTarget,
  releases: Releases,
  tag: string,
  asset: string,
): Promise<string | null> => {
  const [binary, checksums] = await Promise.all([
    download(assetUrl(releases, tag, asset), target.token),
    download(assetUrl(releases, tag, "checksums.txt"), target.token).then((bytes) =>
      new TextDecoder().decode(bytes),
    ),
  ]);
  if (checksumFor(checksums, asset) !== sha256(binary)) {
    return `checksum mismatch for ${asset}; the installed yok is unchanged`;
  }
  // Renaming over the running file is safe on macOS and Linux: the process keeps its open copy.
  const next = `${target.execPath}.new`;
  await writeFile(next, binary);
  await chmod(next, 0o755);
  await rename(next, target.execPath);
  return null;
};

// binaryReady: the newest release is in place at execPath, whatever the plugin install did.
export type UpdateOutcome = Readonly<{ code: number; binaryReady: boolean }>;

const failed = (message: string): UpdateOutcome => {
  console.error(message);
  return { code: 1, binaryReady: false };
};

// Only the agents the user named go along: the new binary picks the rest, since it alone knows
// every agent its release supports.
const installPluginWith = (
  binary: string,
  named: readonly WorkflowAgent[] | undefined,
): Promise<number> =>
  spawnInteractive(
    binary,
    ["plugin", "install", ...(named ?? []).flatMap((agent) => ["--agent", agent])],
    { cwd: process.cwd() },
  );

// Returns the exit code. The plugin install runs in target.execPath after the swap: the new binary
// knows its own version, which this process does not.
export const runUpdate = async (
  target: UpdateTarget,
  named: readonly WorkflowAgent[] | undefined,
  preRelease: boolean,
): Promise<UpdateOutcome> => {
  const asset = assetName(process.platform, process.arch);
  const listed = await fetch(target.releasesUrl, {
    headers: { ...authorization(target.token), Accept: "application/vnd.github+json" },
  });
  if (!listed.ok) {
    const hint = listed.status === 404 || listed.status === 401 ? `\n${NO_ACCESS}` : "";
    return failed(`could not list releases: HTTP ${listed.status}${hint}`);
  }
  const releases = ReleasesSchema.parse(await listed.json());
  const tag = pickRelease(releases, asset, preRelease);
  if (tag === null) return failed(`no release has ${asset}`);
  // Not newer is not the same tag: a pre-release is ahead of the newest stable release.
  if (Bun.semver.order(tag.slice(1), target.version) <= 0) {
    console.log(`yok ${target.version} is up to date: the newest release is ${tag}`);
  } else {
    const problem = await replaceBinary(target, releases, tag, asset);
    if (problem !== null) return failed(problem);
    console.log(`yok ${target.version} replaced by ${tag}`);
  }
  const code = await installPluginWith(target.execPath, named);
  return { code, binaryReady: true };
};

// Runs Homebrew or npm, then the plugin install in the upgraded binary. YOK_SELF moves to that
// binary, so the server restart that follows starts it rather than this process's old one.
const runManagedUpdate = async (
  update: ManagedUpdate,
  named: readonly WorkflowAgent[] | undefined,
): Promise<UpdateOutcome> => {
  const [command, ...args] = update.upgrade;
  const upgraded = await spawnInteractive(command, args, { cwd: process.cwd() });
  if (upgraded !== 0) return failed(`${update.upgrade.join(" ")} exited with ${upgraded}`);
  process.env.YOK_SELF = JSON.stringify([update.binary]);
  return { code: await installPluginWith(update.binary, named), binaryReady: true };
};

// Only the release download needs the token, so a Homebrew or npm update works without gh.
const update = async (
  named: readonly WorkflowAgent[] | undefined,
  preRelease: boolean,
  source: ReleaseSource,
  env: Readonly<Record<string, string | undefined>>,
): Promise<UpdateOutcome> => {
  const execPath = realpathSync(source.execPath);
  const manager = installedBy(execPath);
  if (manager === null) return runUpdate({ ...source, token: githubToken(env) }, named, preRelease);
  const managed = managedUpdate(manager, execPath, preRelease);
  return managed.ok ? runManagedUpdate(managed.value, named) : failed(managed.error);
};

export type UpdateRequest = Readonly<{
  agent: readonly WorkflowAgent[] | undefined;
  preRelease: boolean;
  env: Readonly<Record<string, string | undefined>>;
  // The release this binary updates from; built from this process when absent.
  target?: ReleaseSource;
}>;

// The update command without the server restart, which the action runs once the binary is ready.
export const updateYok = async (
  { agent, preRelease, env, target }: UpdateRequest,
  compiled: boolean = isCompiled,
): Promise<UpdateOutcome> => {
  if (!compiled) return failed(DEV_UPDATE);
  // Checked before the download, so no binary moves when there is no plugin to move with it.
  const agents = updateAgents(agent, env);
  if (!agents.ok) return failed(agents.error);
  const from = target ?? {
    releasesUrl: RELEASES_URL,
    execPath: process.execPath,
    version: VERSION,
  };
  return update(agent, preRelease, from, env);
};

export const updateCommand = () =>
  new Command("update")
    .description(
      "Install the newest yok release (through Homebrew or npm if they installed it), move the plugin to it, and restart the server",
    )
    .option("--pre-release", "take the newest release of any kind, not only stable")
    .addOption(agentOption("claude or codex; repeat for both; default: every one found on PATH"))
    .action(async ({ agent, preRelease }) => {
      const { code, binaryReady } = await updateYok({
        agent,
        preRelease: preRelease === true,
        env: process.env,
      });
      process.exitCode = code;
      if (!binaryReady) return;
      // The server keeps running the binary it started from until it is restarted. A failed
      // plugin install does not change that, so the restart happens anyway.
      try {
        if (await restartServer()) console.log("restarted the yok server on the installed binary");
      } catch (error) {
        fail(error instanceof Error ? error : String(error));
      }
    });

// Must match the line install.sh appends to the shell's rc file.
const PATH_LINE =
  'case ":$PATH:" in *":$HOME/.yok/bin:"*) ;; *) export PATH="$HOME/.yok/bin:$PATH" ;; esac';

const RC_FILES = [".zshrc", ".bashrc", ".profile"] as const;

export type InstallPaths = Readonly<{
  execPath: string | null;
  installDir: string;
  rcFiles: readonly string[];
}>;

const isInside = (path: string, dir: string): boolean => !relative(dir, path).startsWith("..");

// install.sh writes a blank line before the PATH line, so both go.
const withoutPathLine = (text: string): string =>
  text
    .replace(`\n${PATH_LINE}\n`, "")
    .split("\n")
    .filter((line) => line !== PATH_LINE)
    .join("\n");

const removePathLine = async (rc: string): Promise<boolean> => {
  const text = await readFile(rc, "utf8").catch(() => null);
  if (text === null || !text.includes(PATH_LINE)) return false;
  await writeFile(rc, withoutPathLine(text));
  return true;
};

// Returns what it removed, one line each. A null execPath keeps the binary. The yok-remote
// install.sh writes beside the binary goes with it.
export const removeInstall = async ({
  execPath,
  installDir,
  rcFiles,
}: InstallPaths): Promise<readonly string[]> => {
  const outside = execPath === null || isInside(execPath, installDir) ? [] : [execPath];
  const shortcut = outside
    .map((path) => join(dirname(path), "yok-remote"))
    .filter((path) => existsSync(path));
  const binary = [...outside, ...shortcut];
  for (const path of [...binary, installDir]) await rm(path, { recursive: true, force: true });
  const cleaned: string[] = [];
  for (const rc of rcFiles) if (await removePathLine(rc)) cleaned.push(rc);
  return [
    ...[...binary, installDir].map((path) => `removed ${path}`),
    ...cleaned.map((rc) => `removed the yok PATH line from ${rc}`),
  ];
};

// Without a terminal to answer, the plugin stays.
const askYes = async (question: string): Promise<boolean> => {
  if (process.stdin.isTTY !== true) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(question).finally(() => prompt.close());
  return /^y(es)?$/i.test(answer.trim());
};

// An agent that is not installed has no plugin to remove.
const removePlugins = async (): Promise<boolean> => {
  for (const agent of agentsOnPath(process.env)) {
    const binary = agentBinary(agent, process.env);
    const result = await uninstallPlugin(agent, binary, execWithTimeout(120_000), process.cwd());
    if (!result.ok) {
      fail(result.error);
      return false;
    }
    console.log(result.value);
  }
  return true;
};

const uninstall = async (plugin: boolean | undefined): Promise<void> => {
  const home = yokHome();
  const running = await runningServer(home);
  if (running !== null) {
    await stopServer(running.pid);
    console.log(`stopped the yok server (pid ${running.pid}); its tmux sessions keep running`);
  }
  const withPlugin =
    plugin ?? (await askYes("Also remove the yok plugin from claude and codex? [y/N] "));
  // Stops before the binary goes, so a failed plugin removal can be run again.
  if (withPlugin && !(await removePlugins())) return;
  const rcFiles = RC_FILES.map((name) => join(homedir(), name));
  // Always install.sh's folder, never YOK_HOME: that can point anywhere, even at $HOME.
  const installDir = join(homedir(), ".yok");
  const manager = installedBy(realExecPath());
  const execPath = manager === null ? process.execPath : null;
  for (const line of await removeInstall({ execPath, installDir, rcFiles })) console.log(line);
  if (!withPlugin) console.log("kept the yok plugin");
  if (manager !== null) console.log(`yok came from ${manager}: run ${MANAGED_UNINSTALL[manager]}`);
};

export const uninstallCommand = () =>
  new Command("uninstall")
    .description("Remove yok from this machine; asks whether to remove the agent plugin too")
    .option("--plugin", "also remove the yok plugin from claude and codex, without asking")
    .option("--no-plugin", "keep the yok plugin, without asking")
    .action(async ({ plugin }) => {
      if (!isCompiled) return fail(DEV_UNINSTALL);
      await uninstall(plugin).catch((error: unknown) =>
        fail(error instanceof Error ? error : String(error)),
      );
    });
