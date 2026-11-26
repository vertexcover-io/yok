import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
  type IGit,
  type ILogger,
  type IStorage,
  type ITerminalHost,
  type Result,
  runDirOf,
  type WorkflowRun,
} from "@yok/sdk";
import { findProjectConflict, isRunLive } from "@yok/sdk/internal";
import type { Context } from "hono";
import { Hono } from "hono";
import * as z from "zod";
import { errorResponse, jsonBody, type Vars } from "./api.ts";
import { isAgentAlive, readStateOrNull } from "./delivery.ts";
import { forgetFinishedRun } from "./overview.ts";
import {
  type AddProjectBody,
  AddProjectBodySchema,
  type ErrorCode,
  type Project,
  type ProjectView,
} from "./protocol.ts";

export const CLONE_TIMEOUT_MS = 10 * 60_000;

export type ProjectDeps = Readonly<{
  home: string;
  storage: IStorage;
  host: ITerminalHost;
  git: IGit;
}>;

const clonesDir = (home: string): string => join(home, "projects");

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

// The named project's checkout, and whether yok cloned it: a run pulls a clone first.
export const pickProject = async (
  storage: IStorage,
  home: string,
  name: string,
): Promise<Result<Readonly<{ name: string; path: string; cloned: boolean }>>> => {
  const project = await storage.projects.find(name);
  if (project === undefined) return { ok: false, error: `unknown project "${name}"` };
  if (!existsSync(project.path)) {
    return { ok: false, error: `project ${name}'s checkout ${project.path} is gone` };
  }
  return { ok: true, value: { name, path: project.path, cloned: isClone(home, project) } };
};

// A body that fails its schema. The reply never lists the server's projects: a caller who can
// reach the route is not thereby entitled to its inventory.
export const refuseBody = (c: Context, error: z.core.$ZodError) =>
  errorResponse(c, 400, "bad-request", z.prettifyError(error));

// Only a folder yok cloned is deleted or pulled: a project added by path, or a symlink, that sits
// in the clones folder belongs to the person who named it.
const isClone = (home: string, project: Project): boolean => {
  const clones = clonesDir(home);
  if (project.git === undefined || !existsSync(project.path) || !existsSync(clones)) return false;
  return realpathSync(project.path).startsWith(realpathSync(clones) + sep);
};

// Only a folder this add cloned is removed; a checkout the caller named is theirs.
const removeClone = (git: string | undefined, path: string): Promise<void> =>
  git === undefined ? Promise.resolve() : rm(path, { recursive: true, force: true });

// Making the folder first claims it: a second add of the same name finds it and clones nothing.
const claimAndClone = async (
  git: IGit,
  { home, url, path }: Readonly<{ home: string; url: string; path: string }>,
  log: ILogger,
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
  // git's stderr can echo the URL or the server's paths; it goes to the log, not to the caller.
  log.info({ url, err: cloned.error }, "git clone failed");
  return {
    ok: false,
    error: { status: 422, code: "git-failed", message: "git clone failed; see the server log" },
  };
};

// The clone runs outside any transaction, so a slow clone holds up no run start; the conflicts
// are checked again by the save. Each refusal leaves no entry and no clone behind. Neither the
// config nor the doctor is checked here: a run start checks the checkout.
const addProject = async (
  c: Context<{ Variables: Vars }>,
  deps: ProjectDeps,
  body: AddProjectBody,
) => {
  const { name, git, addedBy } = body;
  const projects = await deps.storage.projects.list();
  const taken = findProjectConflict(projects, { name, git });
  if (taken !== null) return errorResponse(c, 409, "conflict", taken);
  const path = body.path ?? join(clonesDir(deps.home), name);
  if (git !== undefined) {
    const cloned = await claimAndClone(deps.git, { home: deps.home, url: git, path }, c.get("log"));
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
  const owned = findProjectConflict(projects, { name, root: root.value });
  if (owned !== null) return refuse(409, owned);
  // The caller wins over the body: the in-memory Slack client has no caller and names the
  // member's yok user in addedBy.id, which only counts when that user exists.
  const user = c.get("caller")?.userId ?? addedBy.id;
  const known = user === undefined ? undefined : await deps.storage.users.find(user);
  const project: Project = {
    path: root.value,
    ...(git === undefined ? {} : { git }),
    addedBy: {
      channel: addedBy.channel,
      ...(known === undefined || user === undefined ? {} : { user }),
    },
    addedAt: new Date().toISOString(),
  };
  const saved = await deps.storage.projects.add(name, project);
  if (!saved.ok) return refuse(409, saved.error);
  return c.json({ project: viewProject(name, project) }, 201);
};

// Long past any launch: a run still without a terminal by then was left by a server that died.
const STARTING_MS = 10 * 60_000;

// A run with no terminal yet is still launching, so it holds its checkout too. A run with no
// state yet is still starting. A finished run's session may stay open, holding nothing.
export const holdsCheckout = async (
  storage: IStorage,
  run: WorkflowRun,
  host: ITerminalHost,
): Promise<boolean> => {
  if (run.terminal === null) return Date.now() - Date.parse(run.createdAt) < STARTING_MS;
  const state = run.name === null ? null : await readStateOrNull(storage, run.id);
  if (state !== null && !isRunLive(state.status)) return false;
  return isAgentAlive(run, host);
};

// The session goes first, so nothing writes into the folder once it is deleted. Only a live pane
// is killed: tmux logs an error for kill-pane on a session already gone.
export const deleteRun = async (
  storage: IStorage,
  run: WorkflowRun,
  host: ITerminalHost,
): Promise<void> => {
  const pane = run.terminal === null ? null : host.find(run.terminal);
  if (pane !== null && (await pane.isAlive())) await pane.kill();
  await storage.runs.removeRun(run.id);
  if (run.name === null) return;
  const runDir = runDirOf(run.cwd, run.name);
  forgetFinishedRun(runDir);
  await rm(runDir, { recursive: true, force: true });
};

// Both refusals come before the first delete: a --force that then refused would have lost runs to
// a removal that never happened. A run still going refuses even --force, keeping its checkout.
const removeProject = async (
  c: Context<{ Variables: Vars }>,
  deps: ProjectDeps,
  { name, force }: Readonly<{ name: string; force: boolean }>,
) => {
  const project = await deps.storage.projects.find(name);
  if (project === undefined) {
    return errorResponse(c, 404, "not-found", `no project named ${name}`);
  }
  const runs = (await deps.storage.runs.listRuns()).filter((run) => run.project === name);
  const holding = await Promise.all(runs.map((run) => holdsCheckout(deps.storage, run, deps.host)));
  const live = runs.filter((_run, index) => holding[index]).map((run) => run.id);
  if (live.length > 0) {
    const message = `${name} has runs still going: ${live.join(", ")}; --force does not remove a run still going`;
    return errorResponse(c, 409, "conflict", message);
  }
  const triggers = (await deps.storage.triggers.list()).filter((t) => t.project === name);
  if (triggers.length > 0) {
    const names = triggers.map((t) => t.name).join(", ");
    const message = `${name} still has triggers: ${names}; remove them first with yok trigger rm NAME --project ${name}`;
    return errorResponse(c, 409, "conflict", message);
  }
  // A run row names its project, so the project goes only once its runs are gone.
  const ids = runs.map((run) => run.id);
  if (ids.length > 0 && !force) {
    const message = `${name} has runs: ${ids.join(", ")}; remove them with yok rm RUN, or pass --force`;
    return errorResponse(c, 409, "conflict", message);
  }
  await Promise.all(runs.map((run) => deleteRun(deps.storage, run, deps.host)));
  const started = await deps.storage.projects.remove(name).then(
    (): readonly string[] => [],
    async (error: unknown) => {
      // A run started since the checks holds the project, and its row refuses the delete.
      const held = (await deps.storage.runs.listRuns()).filter((run) => run.project === name);
      if (held.length === 0) throw error;
      return held.map((run) => run.id);
    },
  );
  if (started.length > 0) {
    const message = `${name} has runs started while it was being removed: ${started.join(", ")}; try again once they finish`;
    return errorResponse(c, 409, "conflict", message);
  }
  // --force removes everything yok owns, so it deletes a clone too.
  const cloned = isClone(deps.home, project);
  if (force && cloned) await rm(project.path, { recursive: true, force: true });
  const note =
    force && !cloned ? `kept ${project.path}: yok deletes only the folders it cloned` : null;
  return c.json({ removed: name, runs: ids, purged: force && cloned, note }, 200);
};

// Mounted at /projects by app.ts. Chained, so each route's types reach ApiType.
export const projectRoutes = (deps: ProjectDeps) =>
  new Hono<{ Variables: Vars }>()
    .get("/", async (c) => {
      const projects = await deps.storage.projects.list();
      const views = Object.entries(projects).map(([name, project]) => viewProject(name, project));
      return c.json({ projects: views }, 200);
    })
    .post("/", jsonBody(AddProjectBodySchema), (c) => addProject(c, deps, c.req.valid("json")))
    .delete(
      "/:name",
      zValidator("query", z.strictObject({ force: z.enum(["true", "false"]).optional() })),
      (c) => {
        const { force } = c.req.valid("query");
        return removeProject(c, deps, { name: c.req.param("name"), force: force === "true" });
      },
    );
