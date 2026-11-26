import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "@commander-js/extra-typings";
import {
  AbsolutePathSchema,
  type Event,
  EventSchema,
  NonEmptyStringSchema,
  parseYaml,
  type Result,
  readIfExists,
  runDirOf,
  SlugSchema,
  type State,
  StateSchema,
  WorkflowRunSchema,
  yokHome,
} from "@yok/sdk";
import {
  builtInHandlers,
  type Comment,
  CommentSchema,
  type Fire,
  FireSchema,
  type ImportedUser,
  type IStorage,
  type LegacyTrigger,
  LegacyTriggerSchema,
  openStorage,
  projectEvents,
  type RunDraft,
  type Trigger,
  TriggerSchema,
} from "@yok/sdk/internal";
import * as z from "zod";

// The files a yok from before yok.db kept. This command, and the import methods of the
// repositories, are deleted once every home has been imported.
const UsersFileSchema = z.record(
  z.string(),
  z.object({
    name: NonEmptyStringSchema,
    email: z.string(),
    accounts: z.object({
      github: z
        .object({
          id: z.number().int(),
          login: NonEmptyStringSchema,
          token: NonEmptyStringSchema.optional(),
        })
        .optional(),
    }),
    slack: NonEmptyStringSchema.optional(),
  }),
);
type OldUser = z.infer<typeof UsersFileSchema>[string];
// Not strict: an old project may still hold `verdict`, or `addedBy.id` and `name`, which go.
const ProjectsFileSchema = z.record(
  SlugSchema,
  z.object({
    path: AbsolutePathSchema,
    git: z.string().optional(),
    addedBy: z.object({ channel: NonEmptyStringSchema }),
    addedAt: z.iso.datetime(),
  }),
);
const OldRunSchema = WorkflowRunSchema.omit({ project: true });
type OldRun = z.infer<typeof OldRunSchema>;
const RegistryFileSchema = z.strictObject({
  version: z.literal(1),
  runs: z.record(z.string(), OldRunSchema),
});
const CommentsFileSchema = z.strictObject({
  version: z.literal(1),
  comments: z.array(CommentSchema),
});
const TriggersFileSchema = z.strictObject({
  version: z.literal(1),
  triggers: z.record(z.string(), z.union([TriggerSchema, LegacyTriggerSchema])),
});

const KINDS = ["users", "projects", "runs", "events", "comments", "triggers", "fires"] as const;
type Kind = (typeof KINDS)[number];
// skipped: left out by rule, for good. failed: not stored, so its file is kept for another try.
type Step = Readonly<{
  counts: Partial<Record<Kind, number>>;
  skipped: readonly string[];
  failed: readonly string[];
}>;
export type ImportReport = Readonly<{
  summary: string;
  skipped: readonly string[];
  failed: readonly string[];
}>;
// done: imported and renamed, or not there. A file not done holds back the files whose records
// point at its rows, so they never land without them.
type FileImport = Readonly<{ steps: readonly Step[]; done: boolean }>;

const FILES = {
  users: "users.json",
  projects: "projects.yaml",
  runs: "registry.json",
  triggers: "triggers.json",
  fires: "trigger-fires.jsonl",
} as const;

const NOTHING: Step = { counts: {}, skipped: [], failed: [] };
const counted = (counts: Step["counts"]): Step => ({ ...NOTHING, counts });
const skip = (why: string): Step => ({ ...NOTHING, skipped: [why] });
const fail = (why: string): Step => ({ ...NOTHING, failed: [why] });

const reasonOf = (error: unknown): string => {
  if (error instanceof z.ZodError) return z.prettifyError(error);
  return error instanceof Error ? error.message : String(error);
};

// null when the file is absent; an error when it is there but cannot be read.
const readOld = async <T>(path: string, parse: (text: string) => T): Promise<Result<T | null>> => {
  try {
    const text = await readIfExists(path);
    return { ok: true, value: text === null ? null : parse(text) };
  } catch (error) {
    return { ok: false, error: `${path}: ${reasonOf(error)}` };
  }
};

// An earlier import's backup is kept: a later one goes to X.imported.2, X.imported.3, …
const freeBackupPath = (path: string, n = 1): string => {
  const target = n === 1 ? `${path}.imported` : `${path}.imported.${n}`;
  return existsSync(target) ? freeBackupPath(path, n + 1) : target;
};

const markImported = async (paths: readonly string[]): Promise<void> => {
  await Promise.all(paths.map((path) => rename(path, freeBackupPath(path))));
};

// One at a time: each step's rows may point at rows an earlier step stored. A record that throws
// fails and the rest go on.
const importEach = async <T>(
  items: readonly T[],
  label: (item: T) => string,
  each: (item: T) => Promise<Step>,
): Promise<readonly Step[]> => {
  const results: Step[] = [];
  for (const item of items) {
    results.push(
      await each(item).catch((error: unknown) => fail(`${label(item)}: ${reasonOf(error)}`)),
    );
  }
  return results;
};

const hasFailed = (steps: readonly Step[]): boolean => steps.some((step) => step.failed.length > 0);

// A file that cannot be read, or holds a record that failed, keeps its name and content, so a
// second run tries it again. scrub rewrites the file just before it is renamed.
const importFile = async <T>(
  path: string,
  parse: (text: string) => T,
  store: (value: T) => Promise<readonly Step[]>,
  scrub?: (value: T) => string,
): Promise<FileImport> => {
  const read = await readOld(path, parse);
  if (!read.ok) return { steps: [fail(read.error)], done: false };
  if (read.value === null) return { steps: [], done: true };
  const steps = await store(read.value);
  if (hasFailed(steps)) return { steps, done: false };
  if (scrub !== undefined) await writeFile(path, scrub(read.value));
  await markImported([path]);
  return { steps, done: true };
};

// The file at path left alone while a file it needs is not done; undefined when none is pending.
const heldBack = (
  path: string,
  needs: Readonly<Record<string, FileImport>>,
): FileImport | undefined => {
  const pending = Object.keys(needs).filter((name) => needs[name]?.done === false);
  if (pending.length === 0) return undefined;
  if (!existsSync(path)) return { steps: [], done: true };
  return { steps: [fail(`${path}: waits for ${pending.join(" and ")} to import`)], done: false };
};

const importedUser = ({ name, email, accounts, slack }: OldUser): ImportedUser => ({
  name,
  email,
  github: accounts.github,
  slack,
});

const withoutToken = (user: OldUser): OldUser => {
  const { github } = user.accounts;
  if (github === undefined) return user;
  const { token: _token, ...kept } = github;
  return { ...user, accounts: { ...user.accounts, github: kept } };
};

// Disconnect clears only yok.db's token, so the backup must not keep a copy of it.
const importUsers = (storage: IStorage, home: string): Promise<FileImport> =>
  importFile(
    join(home, FILES.users),
    (text) => Object.entries(UsersFileSchema.parse(JSON.parse(text))),
    (users) =>
      importEach(
        users,
        ([id]) => `user ${id}`,
        async ([id, user]) => {
          if ((await storage.users.find(id)) !== undefined) {
            return skip(`user ${id}: user ${id} is already stored`);
          }
          const stored = await storage.users.importUser(id, importedUser(user));
          return stored.ok ? counted({ users: 1 }) : fail(`user ${id}: ${stored.error}`);
        },
      ),
    (users) =>
      JSON.stringify(
        Object.fromEntries(users.map(([id, user]) => [id, withoutToken(user)])),
        null,
        2,
      ),
  );

const parseProjects = (text: string): z.infer<typeof ProjectsFileSchema> => {
  const yaml = parseYaml(text, "projects.yaml");
  if (!yaml.ok) throw new Error(yaml.error);
  return ProjectsFileSchema.parse(yaml.value ?? {});
};

type OldProject = z.infer<typeof ProjectsFileSchema>[string];

const importProject = async (
  storage: IStorage,
  name: string,
  project: OldProject,
): Promise<Step> => {
  const stored = await storage.projects.find(name);
  if (stored?.path === project.path) {
    return skip(`project ${name}: project ${name} is already stored`);
  }
  const added = await storage.projects.add(name, project);
  return added.ok ? counted({ projects: 1 }) : fail(`project ${name}: ${added.error}`);
};

const importProjects = (storage: IStorage, home: string): Promise<FileImport> =>
  importFile(
    join(home, FILES.projects),
    (text) => Object.entries(parseProjects(text)),
    (projects) =>
      importEach(
        projects,
        ([name]) => `project ${name}`,
        ([name, project]) => importProject(storage, name, project),
      ),
  );

type RunFolder = Readonly<{
  state: State;
  events: readonly Event[];
  comments: readonly Comment[];
  read: readonly string[];
}>;

const parseEvents = (text: string): readonly Event[] => {
  const events = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => EventSchema.parse(JSON.parse(line)));
  const gap = events.findIndex((event, index) => event.seq !== index + 1);
  if (gap !== -1) throw new Error(`line ${gap + 1} has seq ${events[gap]?.seq}`);
  return events;
};

// state.json is the fold of the log up to its lastEventSeq, from a first state init built out
// of the run's config and its git HEAD at the time, which no event records. So it is the fold's
// starting point, and only events past it are applied; the run's own handlers are not loaded.
const foldOnto = (seed: State, events: readonly Event[], path: string): Result<State> => {
  try {
    return { ok: true, value: projectEvents({ state: seed, events, handlers: builtInHandlers }) };
  } catch (error) {
    return { ok: false, error: `${path}: ${reasonOf(error)}` };
  }
};

const readComments = async (dir: string): Promise<Result<Pick<RunFolder, "comments" | "read">>> => {
  const path = join(dir, "comments.json");
  const read = await readOld(path, (text) => CommentsFileSchema.parse(JSON.parse(text)).comments);
  if (!read.ok) return read;
  if (read.value === null) return { ok: true, value: { comments: [], read: [] } };
  return { ok: true, value: { comments: read.value, read: [path] } };
};

const readRunFolder = async (dir: string): Promise<Result<RunFolder>> => {
  const statePath = join(dir, "state.json");
  const eventsPath = join(dir, "event.jsonl");
  const seed = await readOld(statePath, (text) => StateSchema.parse(JSON.parse(text)));
  if (!seed.ok) return seed;
  if (seed.value === null) return { ok: false, error: `${statePath} is missing` };
  const log = await readOld(eventsPath, parseEvents);
  if (!log.ok) return log;
  const events = log.value ?? [];
  const state = foldOnto(seed.value, events, eventsPath);
  if (!state.ok) return state;
  const comments = await readComments(dir);
  if (!comments.ok) return comments;
  const read = [statePath, ...(log.value === null ? [] : [eventsPath]), ...comments.value.read];
  return {
    ok: true,
    value: { comments: comments.value.comments, state: state.value, events, read },
  };
};

const labelOf = (run: OldRun): string => `run ${run.id} (${run.name ?? "unnamed"})`;

// A name is reused only after its folder was deleted, so `.yok/NAME` and the files in it belong
// to the newest run with that name in that checkout; an older one lost its events with the folder.
const isSuperseded = (run: OldRun, runs: readonly OldRun[]): boolean =>
  run.name !== null &&
  runs.some(
    (other) => other.cwd === run.cwd && other.name === run.name && other.createdAt > run.createdAt,
  );

// runs.user_id must point at a user row, so a starter users.json did not hold is dropped.
const draftOf = async (storage: IStorage, run: OldRun): Promise<RunDraft> => {
  const { cwd, user, ...fields } = run;
  const known = user !== undefined && (await storage.users.find(user)) !== undefined;
  const project = await storage.projects.findOrAddFolder(cwd);
  return { ...fields, project, ...(known ? { user } : {}) };
};

const importNamedRun = async (storage: IStorage, run: OldRun, name: string): Promise<Step> => {
  const dir = runDirOf(run.cwd, name);
  if (!existsSync(dir)) return skip(`${labelOf(run)}: its folder ${dir} is gone`);
  const folder = await readRunFolder(dir);
  if (!folder.ok) return fail(`${labelOf(run)}: ${folder.error}`);
  const { state, events, comments, read } = folder.value;
  const stored = await storage.runs.importRun({ run: await draftOf(storage, run), state, events });
  if (!stored.ok) return fail(`${labelOf(run)}: ${stored.error}`);
  await storage.comments.importComments(run.id, comments);
  await markImported(read);
  return counted({ runs: 1, events: events.length, comments: comments.length });
};

const importRun = async (
  storage: IStorage,
  run: OldRun,
  runs: readonly OldRun[],
): Promise<Step> => {
  if (isSuperseded(run, runs)) return skip(`${labelOf(run)}: a newer run took its name and folder`);
  // Before its folder is read: a stored run's files were already renamed.
  if ((await storage.runs.findRun(run.id)) !== undefined) {
    return skip(`${labelOf(run)}: run ${run.id} is already stored`);
  }
  if (run.name !== null) return importNamedRun(storage, run, run.name);
  const draft = await draftOf(storage, run);
  const stored = await storage.runs.importRun({ run: draft, state: null, events: [] });
  return stored.ok ? counted({ runs: 1 }) : fail(`${labelOf(run)}: ${stored.error}`);
};

const importRuns = (storage: IStorage, home: string): Promise<FileImport> =>
  importFile(
    join(home, FILES.runs),
    (text) => Object.values(RegistryFileSchema.parse(JSON.parse(text)).runs),
    (runs) => importEach(runs, labelOf, (run) => importRun(storage, run, runs)),
  );

// A trigger saved before triggers named a project moves to the project at its folder.
const adopt = async (storage: IStorage, stored: Trigger | LegacyTrigger): Promise<Trigger> => {
  if (!("cwd" in stored)) return stored;
  const { cwd, workflowPath, ...schedule } = stored;
  const project = await storage.projects.findOrAddFolder(cwd);
  return { ...schedule, project, workflow: workflowPath };
};

// importTrigger refuses only a trigger already stored.
const importTriggers = (storage: IStorage, home: string): Promise<FileImport> =>
  importFile(
    join(home, FILES.triggers),
    (text) => Object.values(TriggersFileSchema.parse(JSON.parse(text)).triggers),
    (triggers) =>
      importEach(
        triggers,
        (stored) => `trigger ${stored.id}`,
        async (stored) => {
          const trigger = await adopt(storage, stored);
          if ((await storage.projects.find(trigger.project)) === undefined) {
            return fail(`trigger ${trigger.id}: its project ${trigger.project} is not stored`);
          }
          const imported = await storage.triggers.importTrigger(trigger);
          return imported.ok
            ? counted({ triggers: 1 })
            : skip(`trigger ${stored.id}: ${imported.error}`);
        },
      ),
  );

type Known = Readonly<{
  triggers: ReadonlySet<string>;
  runs: ReadonlySet<string>;
  fires: ReadonlySet<string>;
}>;

const fireKey = ({ triggerId, slot, at }: Fire): string => `${triggerId} ${slot} ${at}`;

const parseFire = (line: string): Fire | null => {
  try {
    return FireSchema.parse(JSON.parse(line));
  } catch {
    return null;
  }
};

// A removed trigger's fires are dropped: nothing lists them. A fire keeps its run only when that
// run was imported; its runName stays either way.
const importFire = async (storage: IStorage, fire: Fire, known: Known): Promise<Step> => {
  if (!known.triggers.has(fire.triggerId)) return NOTHING;
  if (known.fires.has(fireKey(fire))) {
    return skip(`fire of ${fire.triggerId} for ${fire.slot} is already stored`);
  }
  const { runId, ...rest } = fire;
  await storage.triggers.appendFire(runId !== undefined && known.runs.has(runId) ? fire : rest);
  return counted({ fires: 1 });
};

const importFires = (storage: IStorage, home: string): Promise<FileImport> => {
  const path = join(home, FILES.fires);
  return importFile(
    path,
    (text) => text.split("\n").filter((line) => line !== ""),
    async (lines) => {
      const triggers = (await storage.triggers.list()).map((trigger) => trigger.id);
      const stored = await Promise.all(
        triggers.map((id) => storage.triggers.readFires(id, Number.MAX_SAFE_INTEGER)),
      );
      const known: Known = {
        triggers: new Set(triggers),
        runs: new Set((await storage.runs.listRuns()).map((run) => run.id)),
        fires: new Set(stored.flat().map(fireKey)),
      };
      return importEach(
        [...lines.entries()],
        ([index]) => `${path} line ${index + 1}`,
        async ([index, line]) => {
          const fire = parseFire(line);
          if (fire === null) return skip(`${path} line ${index + 1}: not a fire`);
          return importFire(storage, fire, known);
        },
      );
    },
  );
};

const total = (steps: readonly Step[], kind: Kind): number =>
  steps.reduce((sum, step) => sum + (step.counts[kind] ?? 0), 0);

const reportOf = (steps: readonly Step[]): ImportReport => {
  const skipped = steps.flatMap((step) => step.skipped);
  const failed = steps.flatMap((step) => step.failed);
  const counts = KINDS.map((kind) => `${kind}=${total(steps, kind)}`).join(" ");
  return {
    summary: `imported ${counts} skipped=${skipped.length} failed=${failed.length}`,
    skipped,
    failed,
  };
};

// In this order because runs point at users and projects, and fires at triggers and runs.
export const importFiles = async (storage: IStorage, home: string): Promise<ImportReport> => {
  const users = await importUsers(storage, home);
  const projects = await importProjects(storage, home);
  const runs =
    heldBack(join(home, FILES.runs), { [FILES.users]: users, [FILES.projects]: projects }) ??
    (await importRuns(storage, home));
  const triggers =
    heldBack(join(home, FILES.triggers), { [FILES.projects]: projects }) ??
    (await importTriggers(storage, home));
  const fires =
    heldBack(join(home, FILES.fires), { [FILES.triggers]: triggers, [FILES.runs]: runs }) ??
    (await importFires(storage, home));
  return reportOf([users, projects, runs, triggers, fires].flatMap((file) => file.steps));
};

// Exits 1 when a record failed, so a script running the import sees it did not finish.
export const importFilesCommand = () =>
  new Command("import-files")
    .description("Copy the records an older yok kept in files into yok.db, once")
    .action(async () => {
      const home = yokHome();
      const storage = openStorage(home);
      try {
        const { summary, skipped, failed } = await importFiles(storage, home);
        for (const why of skipped) console.error(`skipped ${why}`);
        for (const why of failed) console.error(`failed ${why}`);
        console.log(summary);
        if (failed.length > 0) process.exitCode = 1;
      } finally {
        await storage.close();
      }
    });
