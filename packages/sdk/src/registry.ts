import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as z from "zod";
import { PermissionModeSchema } from "./agent.ts";
import {
  AbsolutePathSchema,
  JsonObjectSchema,
  NonEmptyStringSchema,
  ResolvedTiersSchema,
  SessionRefSchema,
  SlugSchema,
} from "./contracts.ts";
import { SavedPoliciesSchema } from "./policies.ts";
import { isCompiled } from "./process.ts";

// The release binary and yok-dev never share a home, so they never share a server.
export const yokHome = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  compiled: boolean = isCompiled,
): string => env.YOK_HOME ?? join(homedir(), compiled ? ".yok" : ".yok-dev");

export const WorkflowRunSchema = z.strictObject({
  id: NonEmptyStringSchema,
  // the project the run belongs to; its folder is the run's cwd
  project: SlugSchema,
  workflow: SlugSchema,
  workflowPath: NonEmptyStringSchema,
  inputs: JsonObjectSchema,
  // read from the project's path; a stored run keeps no folder of its own
  cwd: NonEmptyStringSchema,
  // The first is the session `yok run` launched.
  sessions: z.array(SessionRefSchema),
  // Set by init; the run's folder is CWD/.yok/NAME.
  name: SlugSchema.nullable(),
  // tmux session the run's agent lives in; null until the server launches it
  terminal: NonEmptyStringSchema.nullable().default(null),
  // the config file `yok run --config` named; init settles the run's config from it
  config: AbsolutePathSchema.nullable().default(null),
  // the run's merged tier set, resolved once by the server at launch; init copies it into state
  tiers: ResolvedTiersSchema.nullable(),
  // the run's merged policies, resolved once by the server at launch; init copies them into state
  policies: SavedPoliciesSchema.optional(),
  // set only for a trigger's run; every session the run starts later launches in it too
  permissionMode: PermissionModeSchema.optional(),
  // where it was started; absent on runs saved before this field, which all came through the API.
  // Only a Slack run is held to its starter's GitHub access; any other keeps the server's login.
  source: z.enum(["api", "slack", "trigger"]).optional(),
  // the yok user who started it; absent when no yok user did (yok run, a trigger, an unlinked
  // Slack member)
  user: NonEmptyStringSchema.optional(),
  createdAt: z.iso.datetime(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export type SessionRef = z.infer<typeof SessionRefSchema>;

// What a run is stored as: the run minus cwd, which is read from its project.
export const RunDraftSchema = WorkflowRunSchema.omit({ cwd: true });
export type RunDraft = z.infer<typeof RunDraftSchema>;

export const ProjectSchema = z.strictObject({
  path: AbsolutePathSchema,
  git: z.string().optional(),
  // where the request came from: cli, server, api or slack; user is the yok user who added it,
  // when one did
  addedBy: z.strictObject({ channel: NonEmptyStringSchema, user: NonEmptyStringSchema.optional() }),
  addedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

// "Refrens_Main" -> "refrens-main": the project name `yok run` gives a new checkout, and the
// server gives the folder of a trigger saved on main. Empty or digit-first when the folder has
// no usable name.
export const folderSlug = (folder: string): string =>
  folder
    .replace(/\.git$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// The name `yok run` gives a folder. Nobody is asked, so a name another folder holds gets the
// first free number, and a folder with no usable name starts with "project".
export const chooseProjectName = (
  projects: Readonly<Record<string, Project>>,
  folder: string,
): string => {
  const slug = folderSlug(basename(folder));
  const base = /^[a-z]/.test(slug) ? slug : `project-${slug}`.replace(/-$/, "");
  const numbered = Object.keys(projects).map((_name, index) => `${base}-${index + 2}`);
  return [base, ...numbered].find((name) => projects[name] === undefined) ?? base;
};

// Why a project cannot be saved beside PROJECTS, or null. The root is unknown before a clone.
export const findProjectConflict = (
  projects: Readonly<Record<string, Project>>,
  { name, git, root }: Readonly<{ name: string; git?: string | undefined; root?: string }>,
): string | null => {
  if (projects[name] !== undefined) return `a project named ${name} already exists`;
  if (git !== undefined && Object.values(projects).some((project) => project.git === git)) {
    return `${git} is already a project`;
  }
  const owner = Object.entries(projects).find(([, project]) => project.path === root);
  return owner === undefined ? null : `${root} is already project ${owner[0]}`;
};
