import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { AbsolutePathSchema, NonEmptyStringSchema, type Result, SlugSchema } from "./contracts.ts";
import { readIfExists, updateJsonFile } from "./files.ts";
import { type ILogger, noopLogger } from "./logger.ts";

export const triggersPath = (home: string): string => join(home, "triggers.json");
export const triggerFiresPath = (home: string): string => join(home, "trigger-fires.jsonl");

const scheduleFields = {
  id: SlugSchema,
  // the workflow's name, unique per project
  name: SlugSchema,
  config: AbsolutePathSchema.nullable(),
  cron: NonEmptyStringSchema,
  timezone: NonEmptyStringSchema,
  nextFireAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
};

// Only the schedule is stored; the workflow file is read again at every firing.
export const TriggerSchema = z.strictObject({
  ...scheduleFields,
  project: SlugSchema,
  // a shipped workflow's name, or the absolute path of a workflow file
  workflow: NonEmptyStringSchema,
});
export type Trigger = z.infer<typeof TriggerSchema>;
export type TriggerDraft = Omit<Trigger, "id" | "createdAt">;

// Saved before triggers named a project. The server rewrites each one on start; until then
// the store's reads and the tick pass over it.
export const LegacyTriggerSchema = z.strictObject({
  ...scheduleFields,
  workflowPath: AbsolutePathSchema,
  cwd: AbsolutePathSchema,
});
export type LegacyTrigger = z.infer<typeof LegacyTriggerSchema>;

export const TriggersFileSchema = z.strictObject({
  version: z.literal(1),
  triggers: z.record(z.string(), z.union([TriggerSchema, LegacyTriggerSchema])),
});
type TriggersFile = z.infer<typeof TriggersFileSchema>;
type StoredTrigger = TriggersFile["triggers"][string];

const isLegacy = (trigger: StoredTrigger): trigger is LegacyTrigger => "cwd" in trigger;

const listCurrent = (file: TriggersFile): readonly Trigger[] =>
  Object.values(file.triggers).filter((t): t is Trigger => !isLegacy(t));

export const FireSchema = z.strictObject({
  triggerId: SlugSchema,
  // the cron time this firing is for
  slot: z.iso.datetime(),
  status: z.enum(["started", "skipped", "failed"]),
  reason: z.string().optional(),
  runId: z.string().optional(),
  runName: z.string().optional(),
  at: z.iso.datetime(),
});
export type Fire = z.infer<typeof FireSchema>;

export type TriggerStore = Readonly<{
  list: () => Promise<readonly Trigger[]>;
  find: (project: string, name: string) => Promise<Trigger | undefined>;
  // Adds the trigger, or updates the one with the same project, name and workflow (keeping its
  // id). Refused when, in the same project, the name belongs to another workflow or the workflow
  // to another name; the error is the trigger it clashes with.
  save: (draft: TriggerDraft) => Promise<Result<Trigger, Trigger>>;
  remove: (id: string) => Promise<boolean>;
  // False, and nothing written, if the trigger was removed or its schedule changed since read.
  setNextFireAt: (trigger: Trigger, nextFireAt: string) => Promise<boolean>;
  appendFire: (fire: Fire) => Promise<void>;
  readFires: (triggerId: string, limit: number) => Promise<readonly Fire[]>;
  listLegacy: () => Promise<readonly LegacyTrigger[]>;
  // Rewrites the legacy trigger to name PROJECT; its id, schedule and fire log stay.
  adopt: (id: string, project: string) => Promise<void>;
}>;

const readTriggers = async (path: string): Promise<TriggersFile> => {
  const text = await readIfExists(path);
  return text === null ? { version: 1, triggers: {} } : TriggersFileSchema.parse(JSON.parse(text));
};

const findIn = (file: TriggersFile, project: string, name: string): Trigger | undefined =>
  listCurrent(file).find((t) => t.project === project && t.name === name);

const clashIn = (file: TriggersFile, draft: TriggerDraft): Trigger | undefined =>
  listCurrent(file).find((t) => {
    const sameName = t.name === draft.name;
    const sameFile = t.workflow === draft.workflow;
    return t.project === draft.project && sameName !== sameFile;
  });

const saveDraft = (file: TriggersFile, draft: TriggerDraft): TriggersFile => {
  if (clashIn(file, draft) !== undefined) return file;
  const existing = findIn(file, draft.project, draft.name);
  const trigger: Trigger = {
    ...draft,
    id: existing?.id ?? `t-${randomBytes(4).toString("hex")}`,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  return { ...file, triggers: { ...file.triggers, [trigger.id]: trigger } };
};

const removeTrigger = (file: TriggersFile, id: string): TriggersFile => {
  if (file.triggers[id] === undefined) return file;
  const { [id]: _removed, ...triggers } = file.triggers;
  return { ...file, triggers };
};

const moveNextFire = (file: TriggersFile, read: Trigger, nextFireAt: string): TriggersFile => {
  const stored = file.triggers[read.id];
  if (stored?.cron !== read.cron || stored.timezone !== read.timezone) return file;
  return { ...file, triggers: { ...file.triggers, [read.id]: { ...stored, nextFireAt } } };
};

const parseFire = (line: string): Fire | null => {
  try {
    return FireSchema.parse(JSON.parse(line));
  } catch {
    return null;
  }
};

// Skips a broken line instead of failing, so one bad line doesn't hide the rest.
const readFireLines = async (path: string, log: ILogger): Promise<readonly Fire[]> => {
  const text = await readIfExists(path);
  if (text === null) return [];
  return text
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line, index) => {
      const fire = parseFire(line);
      if (fire === null) log.warn({ line: index + 1 }, "fire log line skipped: not a fire");
      return fire === null ? [] : [fire];
    });
};

export const createTriggerStore = (home: string, parentLog: ILogger = noopLogger): TriggerStore => {
  const path = triggersPath(home);
  const firesPath = triggerFiresPath(home);
  const log = parentLog.child({ component: "triggers", path: firesPath });
  return {
    list: async () => listCurrent(await readTriggers(path)),
    find: async (project, name) => findIn(await readTriggers(path), project, name),
    save: async (draft) => {
      const { before, after } = await updateJsonFile(path, readTriggers, (current) =>
        saveDraft(current, draft),
      );
      const clash = clashIn(before, draft);
      if (clash !== undefined) return { ok: false, error: clash };
      const saved = findIn(after, draft.project, draft.name);
      if (saved === undefined) throw new Error(`trigger ${draft.name} was not saved`);
      return { ok: true, value: saved };
    },
    remove: async (id) => {
      const { before } = await updateJsonFile(path, readTriggers, (current) =>
        removeTrigger(current, id),
      );
      return before.triggers[id] !== undefined;
    },
    setNextFireAt: async (trigger, nextFireAt) => {
      const { before, after } = await updateJsonFile(path, readTriggers, (current) =>
        moveNextFire(current, trigger, nextFireAt),
      );
      return after !== before;
    },
    appendFire: async (fire) => {
      await mkdir(home, { recursive: true });
      // If the server died mid-write, the last line has no newline. Add one first, so this
      // record starts on its own line instead of joining the broken one.
      const text = await readIfExists(firesPath);
      const torn = text !== null && text !== "" && !text.endsWith("\n");
      await appendFile(firesPath, `${torn ? "\n" : ""}${JSON.stringify(FireSchema.parse(fire))}\n`);
    },
    readFires: async (triggerId, limit) =>
      (await readFireLines(firesPath, log)).filter((f) => f.triggerId === triggerId).slice(-limit),
    listLegacy: async () => Object.values((await readTriggers(path)).triggers).filter(isLegacy),
    adopt: async (id, project) => {
      await updateJsonFile(path, readTriggers, (current) => {
        const stored = current.triggers[id];
        if (stored === undefined || !isLegacy(stored)) return current;
        const { cwd: _cwd, workflowPath, ...schedule } = stored;
        const adopted: Trigger = { ...schedule, project, workflow: workflowPath };
        return { ...current, triggers: { ...current.triggers, [id]: adopted } };
      });
    },
  };
};
