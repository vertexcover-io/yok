import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  type IGit,
  type ITerminalHost,
  parseYaml,
  type Result,
  readIfExists,
  runDirOf,
  SlugSchema,
  type WorkflowRun,
  withLock,
} from "@yok/sdk";
import { isRunLive, type Registry, stringifyYaml, type TriggerStore } from "@yok/sdk/internal";
import type { Context } from "hono";
import { Hono } from "hono";
import * as z from "zod";
import { errorResponse, jsonBody, type Vars } from "./api.ts";
import { isAgentAlive, readStateOrNull } from "./delivery.ts";
import {
  type AddProjectBody,
  AddProjectBodySchema,
  type ErrorCode,
  folderSlug,
  type Project,
  ProjectSchema,
  type ProjectView,
} from "./protocol.ts";

export const CLONE_TIMEOUT_MS = 10 * 60_000;

// Not strict: a file that still holds a project's old `verdict` reads, and the next write drops it.
const ProjectsFileSchema = z.record(SlugSchema, z.object(ProjectSchema.shape));
type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

export type ProjectDeps = Readonly<{
  home: string;
  registry: Registry;
  host: ITerminalHost;
  git: IGit;
  triggers: TriggerStore;
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

// The name `yok run` gives the folder. Nobody is asked here, so a name another folder holds
// gets the first free number, and a folder with no usable name starts with "project".
const chooseProjectName = (projects: ProjectsFile, folder: string): string => {
  const slug = folderSlug(basename(folder));
  const base = /^[a-z]/.test(slug) ? slug : `project-${slug}`.replace(/-$/, "");
  const numbered = Object.keys(projects).map((_name, index) => `${base}-${index + 2}`);
  return [base, ...numbered].find((name) => projects[name] === undefined) ?? base;
};

// The project at FOLDER, added when there is none. Never refuses: a trigger saved on main for
// this folder must keep a project to fire in.
export const findOrAddFolderProject = (home: string, folder: string): Promise<string> =>
  withLock(projectsLockPath(home), async () => {
    const projects = await readProjects(home);
    const known = Object.entries(projects).find(([, project]) => project.path === folder);
    if (known !== undefined) return known[0];
    const name = chooseProjectName(projects, folder);
    const project: Project = {
      path: folder,
      addedBy: { channel: "server" },
      addedAt: new Date().toISOString(),
    };
    await writeProjects(home, { ...projects, [name]: project });
    return name;
  });

const viewProject = (name: string, project: Project): ProjectView => ({
  name,
  ...project,
  status: existsSync(project.path) ? "ready" : "missing",
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

const knownNames = (projects: ProjectsFile): string => {
  const known = Object.keys(projects);
  return known.length === 0 ? "none; add one with yok project add" : known.join(", ");
};

// The named project's checkout, and whether yok cloned it: a run pulls a clone first.
export const pickProject = async (
  home: string,
  name: string,
): Promise<Result<Readonly<{ name: string; path: string; cloned: boolean }>>> => {
  const projects = await readProjects(home);
  const project = projects[name];
  if (project === undefined) {
    return {
      ok: false,
      error: `unknown project "${name}"; known projects: ${knownNames(projects)}`,
    };
  }
  if (!existsSync(project.path)) {
    return { ok: false, error: `project ${name}'s checkout ${project.path} is gone` };
  }
  return { ok: true, value: { name, path: project.path, cloned: isClone(home, project) } };
};

// A body that fails its schema. When the project is what failed, the reply lists the known
// projects, because the server never picks one.
export const refuseBody = async (c: Context, home: string, error: z.core.$ZodError) => {
  const message = z.prettifyError(error);
  if (!error.issues.some((issue) => issue.path[0] === "project")) {
    return errorResponse(c, 400, "bad-request", message);
  }
  const known = knownNames(await readProjects(home));
  return errorResponse(c, 400, "bad-request", `${message}\nknown projects: ${known}`);
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

// Only a folder yok cloned is purged or pulled: a project added by path, or a symlink, that sits
// in the clones folder belongs to the person who named it.
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
  Result<void, Readonly<{ status: 400 | 409 | 422; code: ErrorCode; message: string }>>
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
  return { ok: false, error: { status: 422, code: "git-failed", message: cloned.error } };
};

// The clone runs outside the projects lock, so a slow clone holds up no run start; the conflicts
// are checked again under it. Each refusal leaves no entry and no clone behind. Neither the
// config nor the doctor is checked here: a run start checks the checkout.
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
    const triggers = (await deps.triggers.list()).filter((t) => t.project === name);
    if (triggers.length > 0) {
      const names = triggers.map((t) => t.name).join(", ");
      const message = `${name} still has triggers: ${names}; remove them first with yok trigger rm NAME --project ${name}`;
      return errorResponse(c, 409, "conflict", message);
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
