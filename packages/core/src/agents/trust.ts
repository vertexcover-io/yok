import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createGit, type IGit, type ILogger, parseJson, type Result, readIfExists } from "@yok/sdk";
import * as z from "zod";
import type { WorkflowAgent } from "../workflow/types.ts";

// An agent asks whether to trust a folder it has never opened, and nobody answers that in a
// server-started run, so the folder goes into the agent's own trusted list before launch.
// Claude: https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust
// Codex: https://learn.chatgpt.com/docs/config-file/config-reference (projects.<path>.trust_level)

type Env = Readonly<Record<string, string | undefined>>;
type TrustOutcome = "added" | "present";
// The new file text, or null when the folder is already trusted.
type TrustEdit = (text: string | null, folder: string) => Result<string | null>;
type TrustStore = Readonly<{ path: (env: Env) => string; edit: TrustEdit }>;

// Claude's config lock is a proper-lockfile folder, refreshed while held and stale after 10s.
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_RETRY_MS = 20;

const realpathOr = (path: string): Promise<string> => realpath(path).catch(() => path);

const homeOf = (env: Env): string => env.HOME || homedir();

export const claudeConfigPath = (env: Env): string =>
  join(env.CLAUDE_CONFIG_DIR || homeOf(env), ".claude.json");

export const codexConfigPath = (env: Env): string =>
  join(env.CODEX_HOME || join(homeOf(env), ".codex"), "config.toml");

// Both agents key trust on the repository root, the main checkout's for a linked worktree, and
// on the folder itself outside a repository.
export const trustRoot = async (cwd: string, git: IGit = createGit()): Promise<string> => {
  const commonDir = await git.commonDir(cwd);
  if (commonDir !== null && basename(commonDir) === ".git") return realpathOr(dirname(commonDir));
  return realpathOr((await git.repoRoot(cwd)) ?? cwd);
};

const ClaudeConfigSchema = z.looseObject({
  projects: z
    .record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.unknown().optional() }))
    .optional(),
});

const addClaudeTrust: TrustEdit = (text, folder) => {
  const json = parseJson(text ?? "{}");
  const parsed = ClaudeConfigSchema.safeParse(json.ok ? json.value : undefined);
  if (!parsed.success) return { ok: false, error: "the Claude config is not a JSON object" };
  const config = parsed.data;
  const project = config.projects?.[folder];
  if (project?.hasTrustDialogAccepted === true) return { ok: true, value: null };
  const projects = { ...config.projects, [folder]: { ...project, hasTrustDialogAccepted: true } };
  return { ok: true, value: JSON.stringify({ ...config, projects }, null, 2) };
};

const CodexConfigSchema = z.looseObject({
  projects: z.record(z.string(), z.looseObject({ trust_level: z.unknown().optional() })).optional(),
});

const parseCodexConfig = (text: string): z.infer<typeof CodexConfigSchema> | undefined => {
  try {
    return CodexConfigSchema.safeParse(Bun.TOML.parse(text)).data;
  } catch {
    return undefined;
  }
};

// Codex's TOML parser rejects a `projects` table defined twice, which Bun's lenient one accepts,
// so the table is appended only where `projects` is written as [projects."<path>"] headers.
const INLINE_PROJECTS = /^\s*projects\s*[=.]/m;

// Appending a table leaves every byte the person wrote as it was.
const addCodexTrust: TrustEdit = (text, folder) => {
  const before = text ?? "";
  const config = parseCodexConfig(before);
  if (config === undefined) return { ok: false, error: "the codex config is not valid TOML" };
  const project = config.projects?.[folder];
  if (project?.trust_level === "trusted") return { ok: true, value: null };
  if (project !== undefined) {
    return { ok: false, error: `codex marks ${folder} as ${String(project.trust_level)}` };
  }
  if (INLINE_PROJECTS.test(before)) {
    return { ok: false, error: "projects is written inline, so no table can be added" };
  }
  const gap = before === "" ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const table = `[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n`;
  return { ok: true, value: `${before}${gap}${table}` };
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

// The same lock folder Claude takes on its config, so neither writer loses the other's change.
// The new file goes in by rename, through a symlinked config to its target, with its old mode.
const editConfig = async (
  path: string,
  folder: string,
  edit: TrustEdit,
): Promise<Result<TrustOutcome>> => {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  if (!(await acquireLock(lock, Date.now() + LOCK_WAIT_MS))) {
    return { ok: false, error: `${lock} stayed locked` };
  }
  try {
    const target = await realpathOr(path);
    const edited = edit(await readIfExists(target), folder);
    if (!edited.ok) return { ok: false, error: `${path}: ${edited.error}` };
    if (edited.value === null) return { ok: true, value: "present" };
    const mode = ((await stat(target).catch(() => null))?.mode ?? 0o600) & 0o777;
    const temp = `${target}.yok-${randomUUID()}`;
    await writeFile(temp, edited.value, { mode });
    await rename(temp, target);
    return { ok: true, value: "added" };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
};

const trustStores: Readonly<Record<WorkflowAgent, TrustStore>> = {
  claude: { path: claudeConfigPath, edit: addClaudeTrust },
  codex: { path: codexConfigPath, edit: addCodexTrust },
};

export const trustFolder = async (
  agent: WorkflowAgent,
  cwd: string,
  env: Env,
): Promise<Result<TrustOutcome>> => {
  const store = trustStores[agent];
  try {
    return await editConfig(store.path(env), await trustRoot(cwd), store.edit);
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

// A folder left untrusted only brings the prompt back, so the launch goes on either way. The
// session's env decides which config the agent reads.
export const trustLaunchFolder = async (
  agent: WorkflowAgent,
  options: Readonly<{ cwd: string; env?: Readonly<Record<string, string>> | undefined }>,
  log: ILogger,
): Promise<void> => {
  const trusted = await trustFolder(agent, options.cwd, { ...process.env, ...options.env });
  if (!trusted.ok) log.warn({ cwd: options.cwd, err: trusted.error }, "folder not trusted");
  else if (trusted.value === "added") log.info({ cwd: options.cwd }, "folder trusted");
};
