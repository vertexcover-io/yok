import { asc, eq } from "drizzle-orm";
import type { Result } from "../contracts.ts";
import {
  chooseProjectName,
  findProjectConflict,
  type Project,
  ProjectSchema,
} from "../registry.ts";
import type { IProjectRepository } from "../repositories.ts";
import * as tables from "../schema.ts";
import { type Db, IMMEDIATE, now } from "./common.ts";

type ProjectRow = typeof tables.projects.$inferSelect;

const toProject = (row: ProjectRow): Project =>
  ProjectSchema.parse({
    path: row.path,
    ...(row.git === null ? {} : { git: row.git }),
    addedBy: { channel: row.channel, ...(row.addedBy === null ? {} : { user: row.addedBy }) },
    addedAt: row.createdAt,
  });

const toProjectRow = (name: string, project: Project) => ({
  name,
  path: project.path,
  git: project.git ?? null,
  channel: project.addedBy.channel,
  addedBy: project.addedBy.user ?? null,
  createdAt: project.addedAt,
  updatedAt: now(),
});

const listProjectsIn = (db: Db): Readonly<Record<string, Project>> =>
  Object.fromEntries(
    db
      .select()
      .from(tables.projects)
      .orderBy(asc(tables.projects.createdAt))
      .all()
      .map((row) => [row.name, toProject(row)]),
  );

// Never refuses: a trigger saved on main for this folder must keep a project to fire in.
const findOrAddFolderIn = (db: Db, folder: string): string =>
  db.transaction((tx) => {
    const projects = listProjectsIn(tx);
    const known = Object.entries(projects).find(([, project]) => project.path === folder);
    if (known !== undefined) return known[0];
    const name = chooseProjectName(projects, folder);
    const project = { path: folder, addedBy: { channel: "server" }, addedAt: now() };
    tx.insert(tables.projects).values(toProjectRow(name, project)).run();
    return name;
  }, IMMEDIATE);

const addProjectIn = (db: Db, name: string, project: Project): Result<void> =>
  db.transaction((tx): Result<void> => {
    const claim = { name, git: project.git, root: project.path };
    const conflict = findProjectConflict(listProjectsIn(tx), claim);
    if (conflict !== null) return { ok: false, error: conflict };
    tx.insert(tables.projects).values(toProjectRow(name, project)).run();
    return { ok: true, value: undefined };
  }, IMMEDIATE);

export const projectRepository = (db: Db): IProjectRepository => ({
  list: async () => listProjectsIn(db),
  find: async (name) => {
    const row = db.select().from(tables.projects).where(eq(tables.projects.name, name)).get();
    return row === undefined ? undefined : toProject(row);
  },
  findOrAddFolder: async (folder) => findOrAddFolderIn(db, folder),
  add: async (name, project) => addProjectIn(db, name, project),
  remove: async (name) =>
    db
      .delete(tables.projects)
      .where(eq(tables.projects.name, name))
      .returning({ name: tables.projects.name })
      .all().length > 0,
});
