import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  type IGit,
  type ITerminalHost,
  loadStartConfig,
  parseYaml,
  type Result,
  readIfExists,
  runDirOf,
  SlugSchema,
  type WorkflowRun,
  withLock,
} from "@yok/sdk";
import { isRunLive, type Registry, stringifyYaml } from "@yok/sdk/internal";
import type { Context } from "hono";
import { Hono } from "hono";
import * as z from "zod";
import { errorResponse, jsonBody, type Vars } from "./api.ts";
import { isAgentAlive, readStateOrNull } from "./delivery.ts";
import {
  type AddProjectBody,
  AddProjectBodySchema,
  type ErrorCode,
  type Project,
  ProjectSchema,
  type ProjectView,
} from "./protocol.ts";

export const CLONE_TIMEOUT_MS = 10 * 60_000;

const ProjectsFileSchema = z.record(SlugSchema, ProjectSchema);
type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

export type ProjectDeps = Readonly<{
  home: string;
  registry: Registry;
  host: ITerminalHost;
  git: IGit;
}>;

const projectsPath = (home: string): string => join(home, "projects.yaml");
export const projectsLockPath = (home: string): string => `${projectsPath(home)}.lock`;
const clonesDir = (home: string): string => join(home, "projects");

export const readProjects = async (home: string): Promise<ProjectsFile> => {
  const text = await readIfExists(projectsPath(home));
  if (text === null) return {};
  const yaml = parseYaml(text, projectsPath(home));
  if (!yaml.ok) throw new Error(yaml.error);
  return ProjectsFileSchema.parse(yaml.value ?? {});
};

// Called under projectsLockPath; the rename means the file is never half-written.
export const writeProjects = async (home: string, projects: ProjectsFile): Promise<void> => {
  const tempPath = `${projectsPath(home)}.tmp-${randomUUID()}`;
  await writeFile(tempPath, stringifyYaml(projects));
  await rename(tempPath, projectsPath(home));
};

const projectStatus = (project: Project): ProjectView["status"] => {
  if (!existsSync(project.path)) return "missing";
  if (project.verdict?.startsWith("BLOCKED")) return "blocked";
  return "ready";
};

const viewProject = (name: string, project: Project): ProjectView => ({
  name,
  ...project,
  status: projectStatus(project),
});

const checkoutRoot = async (git: IGit, path: string): Promise<Result<string>> => {
  if (!existsSync(path)) return { ok: false, error: `no folder at ${path}` };
  const root = await git.repoRoot(path);
  if (root === null) return { ok: false, error: `${path} is not a git repository` };
  if (root !== realpathSync(path)) {
    return { ok: false, error: `${path} is inside the repository at ${root}; add its root` };
  }
  return { ok: true, value: root };
};

// The named project, or the only one when none is named.
export const pickProject = async (
  home: string,
  name: string | undefined,
): Promise<Result<Readonly<{ name: string; path: string }>>> => {
  const projects = await readProjects(home);
  const known = Object.keys(projects);
  const list = known.length === 0 ? "none; add one with yok project add" : known.join(", ");
  const picked = name ?? (known.length === 1 ? known[0] : undefined);
  if (picked === undefined) return { ok: false, error: `name a project; known projects: ${list}` };
  const project = projects[picked];
  if (project === undefined) {
    return { ok: false, error: `unknown project "${picked}"; known projects: ${list}` };
  }
  if (!existsSync(project.path)) {
    return { ok: false, error: `project ${picked}'s checkout ${project.path} is gone` };
  }
  return { ok: true, value: { name: picked, path: project.path } };
};

// Under the lock a removal takes, so the removal either sees the pending run or has already
// happened, and then nothing is saved.
export const addRunIfProjectKept = (
  home: string,
  project: Readonly<{ name: string; path: string }>,
  add: () => Promise<void>,
): Promise<boolean> =>
  withLock(projectsLockPath(home), async () => {
    if ((await readProjects(home))[project.name]?.path !== project.path) return false;
    await add();
    return true;
  });

// A project removed while its run was starting is left removed.
export const saveVerdict = (home: string, name: string, line: string): Promise<void> =>
  withLock(projectsLockPath(home), async () => {
    const projects = await readProjects(home);
    const project = projects[name];
    if (project === undefined) return;
    await writeProjects(home, { ...projects, [name]: { ...project, verdict: line } });
  });

// Only a folder yok cloned is purged: a project added by path, or a symlink, that sits in the
// clones folder belongs to the person who named it.
const isClone = (home: string, project: Project): boolean => {
  const clones = clonesDir(home);
  if (project.git === undefined || !existsSync(project.path) || !existsSync(clones)) return false;
  return realpathSync(project.path).startsWith(realpathSync(clones) + sep);
};

// Only a folder this add cloned is removed; a checkout the caller named is theirs.
const removeClone = (git: string | undefined, path: string): Promise<void> =>
  git === undefined ? Promise.resolve() : rm(path, { recursive: true, force: true });

// Why the project cannot be saved beside PROJECTS, or null. The root is unknown before a clone.
const conflictWith = (
  projects: ProjectsFile,
  { name, git, root }: Readonly<{ name: string; git?: string | undefined; root?: string }>,
): string | null => {
  if (projects[name] !== undefined) return `a project named ${name} already exists`;
  if (git !== undefined && Object.values(projects).some((project) => project.git === git)) {
    return `${git} is already a project`;
  }
  const owner = Object.entries(projects).find(([, project]) => project.path === root);
  return owner === undefined ? null : `${root} is already project ${owner[0]}`;
};

// Making the folder first claims it: a second add of the same name finds it and clones nothing.
const claimAndClone = async (
  git: IGit,
  { home, url, path }: Readonly<{ home: string; url: string; path: string }>,
): Promise<
  Result<void, Readonly<{ status: 400 | 409 | 502; code: ErrorCode; message: string }>>
> => {
  await mkdir(dirname(path), { recursive: true });
  const failed = await mkdir(path).then(
    () => null,
    (error: unknown) => error,
  );
  if (failed instanceof Error && "code" in failed && failed.code === "EEXIST") {
    return {
      ok: false,
      error: { status: 409, code: "conflict", message: `${path} already exists` },
    };
  }
  if (failed instanceof Error) {
    return { ok: false, error: { status: 400, code: "bad-request", message: failed.message } };
  }
  const cloned = await git.clone(home, url, path);
  if (cloned.ok) return cloned;
  await rm(path, { recursive: true, force: true });
  return { ok: false, error: { status: 502, code: "git-failed", message: cloned.error } };
};

// The clone runs outside the projects lock, so a slow clone holds up no run start; the conflicts
// are checked again under it. Each refusal leaves no entry and no clone behind. The doctor does
// not run here: a run start checks the checkout.
const addProject = async (
  c: Context<{ Variables: Vars }>,
  deps: ProjectDeps,
  body: AddProjectBody,
) => {
  const { name, git, addedBy } = body;
  const projects = await readProjects(deps.home);
  const taken = conflictWith(projects, { name, git });
  if (taken !== null) return errorResponse(c, 409, "conflict", taken);
  const path = body.path ?? join(clonesDir(deps.home), name);
  if (git !== undefined) {
    const cloned = await claimAndClone(deps.git, { home: deps.home, url: git, path });
    if (!cloned.ok) {
      return errorResponse(c, cloned.error.status, cloned.error.code, cloned.error.message);
    }
  }
  const refuse = async (status: 400 | 409, message: string) => {
    await removeClone(git, path);
    return errorResponse(c, status, status === 409 ? "conflict" : "bad-request", message);
  };
  const root = await checkoutRoot(deps.git, path);
  if (!root.ok) return refuse(400, root.error);
  const owned = conflictWith(projects, { name, root: root.value });
  if (owned !== null) return refuse(409, owned);
  // A missing config is not an error: the doctor reports it when a run starts.
  const config = await loadStartConfig(null, root.value);
  if (!config.ok) return refuse(400, config.error);
  const project: Project = {
    path: root.value,
    ...(git === undefined ? {} : { git }),
    addedBy,
    addedAt: new Date().toISOString(),
  };
  const saved = await withLock(projectsLockPath(deps.home), async () => {
    const current = await readProjects(deps.home);
    const conflict = conflictWith(current, { name, git, root: root.value });
    if (conflict === null) await writeProjects(deps.home, { ...current, [name]: project });
    return conflict;
  });
  if (saved !== null) return refuse(409, saved);
  return c.json({ project: viewProject(name, project) }, 201);
};

// Long past any launch: a run still without a terminal by then was left by a server that died.
const STARTING_MS = 10 * 60_000;

// A run with no terminal yet is still launching, so it holds its checkout too. A run with no
// state yet is still starting. A finished run's session may stay open, holding nothing.
const holdsCheckout = async (run: WorkflowRun, host: ITerminalHost): Promise<boolean> => {
  if (run.terminal === null) return Date.now() - Date.parse(run.createdAt) < STARTING_MS;
  const state = run.name === null ? null : await readStateOrNull(runDirOf(run.cwd, run.name));
  if (state !== null && !isRunLive(state.status)) return false;
  return isAgentAlive(run, host);
};

const removeProject = (
  c: Context<{ Variables: Vars }>,
  deps: ProjectDeps,
  { name, purge }: Readonly<{ name: string; purge: boolean }>,
) =>
  withLock(projectsLockPath(deps.home), async () => {
    const { [name]: project, ...rest } = await readProjects(deps.home);
    if (project === undefined) {
      return errorResponse(c, 404, "not-found", `no project named ${name}`);
    }
    const runs = (await deps.registry.listRuns()).filter((run) => run.cwd === project.path);
    const holding = await Promise.all(runs.map((run) => holdsCheckout(run, deps.host)));
    const live = runs.filter((_run, index) => holding[index]).map((run) => run.id);
    if (live.length > 0) {
      return errorResponse(c, 409, "conflict", `${name} has runs still going: ${live.join(", ")}`);
    }
    await writeProjects(deps.home, rest);
    const cloned = isClone(deps.home, project);
    if (purge && cloned) await rm(project.path, { recursive: true, force: true });
    const note =
      purge && !cloned ? `kept ${project.path}: yok deletes only the folders it cloned` : null;
    return c.json({ removed: name, purged: purge && cloned, note }, 200);
  });

// Mounted at /projects by app.ts. Chained, so each route's types reach ApiType.
export const projectRoutes = (deps: ProjectDeps) =>
  new Hono<{ Variables: Vars }>()
    .get("/", async (c) => {
      const projects = await readProjects(deps.home);
      const views = Object.entries(projects).map(([name, project]) => viewProject(name, project));
      return c.json({ projects: views }, 200);
    })
    .post("/", jsonBody(AddProjectBodySchema), (c) => addProject(c, deps, c.req.valid("json")))
    .delete(
      "/:name",
      zValidator("query", z.strictObject({ purge: z.enum(["true", "false"]).optional() })),
      (c) =>
        removeProject(c, deps, {
          name: c.req.param("name"),
          purge: c.req.valid("query").purge === "true",
        }),
    );
