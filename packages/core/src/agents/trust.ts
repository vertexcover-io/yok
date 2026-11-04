import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createGit, type IGit, type ILogger, parseJson, type Result, readIfExists } from "@yok/sdk";
import * as z from "zod";

// Claude asks once whether to trust a folder and shows a few more one-time dialogs on a new
// machine. Nobody answers them in a server-started run, so their flags go into Claude's config
// before launch.
// https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust
// Codex needs no file: its launch argv carries the trust as a -c override (codex.ts).

type Env = Readonly<Record<string, string | undefined>>;

// Claude's config lock is a proper-lockfile folder, refreshed while held and stale after 10s.
// The SDK's withLock cannot share it: it treats a lock folder with no owner file as broken.
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_RETRY_MS = 20;

export const realpathOr = (path: string): Promise<string> => realpath(path).catch(() => path);

export const claudeConfigPath = (env: Env): string =>
  join(env.CLAUDE_CONFIG_DIR || env.HOME || homedir(), ".claude.json");

const isWithin = (folder: string, root: string): boolean =>
  folder === root || folder.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

// Claude keys trust on the repository root, the main checkout's for a linked worktree, and on
// the folder itself outside a repository. A folder's .git file can point anywhere, so a root the
// folder does not sit in counts only when that repository lists the folder as its worktree.
export const trustRoot = async (cwd: string, git: IGit = createGit()): Promise<string> => {
  const folder = await realpathOr(cwd);
  const commonDir = await git.commonDir(cwd);
  const found =
    commonDir !== null && basename(commonDir) === ".git"
      ? dirname(commonDir)
      : await git.repoRoot(cwd);
  if (found === null) return folder;
  const root = await realpathOr(found);
  if (isWithin(folder, root)) return root;
  const listed = await git.listWorktrees(root);
  if (!listed.ok) return folder;
  const paths = await Promise.all(listed.value.map((entry) => realpathOr(entry.path)));
  return paths.some((path) => isWithin(folder, path)) ? root : folder;
};

// Each flag marks one of Claude's one-time dialogs as answered. Read from Claude Code 2.1.318.
const MACHINE_FLAGS = [
  "hasCompletedOnboarding",
  "hasSeenAutoDefaultNotice",
  "hasSeenAutoModeOutsideReadPrompt",
] as const;
const PROJECT_FLAGS = [
  "hasTrustDialogAccepted",
  "hasClaudeMdExternalIncludesApproved",
  "hasClaudeMdExternalIncludesWarningShown",
] as const;

const ClaudeConfigSchema = z.looseObject({
  projects: z.record(z.string(), z.looseObject({})).optional(),
});
type ClaudeConfig = z.infer<typeof ClaudeConfigSchema>;

const parseClaudeConfig = (text: string | null): Result<ClaudeConfig> => {
  const json = parseJson(text ?? "{}");
  const parsed = ClaudeConfigSchema.safeParse(json.ok ? json.value : undefined);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: "the Claude config is not a JSON object" };
};

const missingMachineFlags = (config: ClaudeConfig): readonly string[] =>
  MACHINE_FLAGS.filter((flag) => !(flag in config));

// A machine-wide flag the user already set keeps its value.
const addMachineFlags = (config: ClaudeConfig): ClaudeConfig => ({
  ...config,
  ...Object.fromEntries(missingMachineFlags(config).map((flag) => [flag, true])),
});

// Claude writes these as false when it first opens a folder, so only true counts as answered.
const addProjectFlags = (config: ClaudeConfig, folder: string): ClaudeConfig => {
  const flags = Object.fromEntries(PROJECT_FLAGS.map((flag) => [flag, true]));
  const project = { ...config.projects?.[folder], ...flags };
  return { ...config, projects: { ...config.projects, [folder]: project } };
};

const isStale = async (lock: string): Promise<boolean> => {
  const info = await stat(lock).catch(() => null);
  return info !== null && Date.now() - info.mtimeMs > STALE_LOCK_MS;
};

const acquireLock = async (lock: string, deadline: number): Promise<boolean> => {
  try {
    await mkdir(lock);
    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  if (await isStale(lock)) await rm(lock, { recursive: true, force: true });
  else if (Date.now() > deadline) return false;
  else await sleep(LOCK_RETRY_MS);
  return acquireLock(lock, deadline);
};

// Under Claude's own lock, so neither writer loses the other's change. The new file goes in by
// rename, through a symlinked config to its target, with its old mode. True when it was written.
const editClaudeConfig = async (
  env: Env,
  edit: (config: ClaudeConfig) => ClaudeConfig,
): Promise<Result<boolean>> => {
  const path = claudeConfigPath(env);
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  if (!(await acquireLock(lock, Date.now() + LOCK_WAIT_MS))) {
    return { ok: false, error: `${lock} stayed locked` };
  }
  try {
    const target = await realpathOr(path);
    const config = parseClaudeConfig(await readIfExists(target));
    if (!config.ok) return { ok: false, error: `${path}: ${config.error}` };
    // Compared as parsed JSON, not file text, so a compact config Claude wrote isn't rewritten.
    const text = JSON.stringify(edit(config.value), null, 2);
    if (text === JSON.stringify(config.value, null, 2)) return { ok: true, value: false };
    const mode = ((await stat(target).catch(() => null))?.mode ?? 0o600) & 0o777;
    const temp = `${target}.yok-${randomUUID()}`;
    await writeFile(temp, text, { mode });
    await rename(temp, target);
    return { ok: true, value: true };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
};

export const trustClaudeFolder = async (cwd: string, env: Env): Promise<Result<boolean>> => {
  try {
    const folder = await trustRoot(cwd);
    return await editClaudeConfig(env, (config) =>
      addProjectFlags(addMachineFlags(config), folder),
    );
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

// A folder left untrusted only brings the prompt back, so the launch goes on either way. The
// session's env decides which config Claude reads.
export const trustLaunchFolder = async (
  options: Readonly<{ cwd: string; env?: Readonly<Record<string, string>> | undefined }>,
  log: ILogger,
): Promise<void> => {
  const trusted = await trustClaudeFolder(options.cwd, { ...process.env, ...options.env });
  if (!trusted.ok) log.warn({ cwd: options.cwd, err: trusted.error }, "folder not trusted");
  else if (trusted.value) log.info({ cwd: options.cwd }, "folder trusted");
};
