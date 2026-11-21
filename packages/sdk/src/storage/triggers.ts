import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Result } from "../contracts.ts";
import type { ITriggerRepository } from "../repositories.ts";
import * as tables from "../schema.ts";
import {
  type Fire,
  FireSchema,
  type Trigger,
  type TriggerDraft,
  TriggerSchema,
} from "../triggers.ts";
import { type Db, IMMEDIATE, now } from "./common.ts";

const toTrigger = ({
  updatedAt: _updatedAt,
  ...row
}: typeof tables.triggers.$inferSelect): Trigger => TriggerSchema.parse(row);

const toFire = ({
  reason,
  runId,
  runName,
  ...fire
}: typeof tables.triggerFires.$inferSelect): Fire =>
  FireSchema.parse({
    ...fire,
    ...(reason === null ? {} : { reason }),
    ...(runId === null ? {} : { runId }),
    ...(runName === null ? {} : { runName }),
  });

// In one project, a name belongs to one workflow and a workflow to one name.
const isClash = (stored: Trigger, draft: TriggerDraft): boolean =>
  (stored.name === draft.name) !== (stored.workflow === draft.workflow);

const saveTriggerIn = (db: Db, draft: TriggerDraft, at: string): Result<Trigger, Trigger> =>
  db.transaction((tx): Result<Trigger, Trigger> => {
    const inProject = tx
      .select()
      .from(tables.triggers)
      .where(eq(tables.triggers.project, draft.project))
      .all()
      .map(toTrigger);
    const clash = inProject.find((stored) => isClash(stored, draft));
    if (clash !== undefined) return { ok: false, error: clash };
    const existing = inProject.find((stored) => stored.name === draft.name);
    const trigger = TriggerSchema.parse({
      ...draft,
      id: existing?.id ?? `t-${randomBytes(4).toString("hex")}`,
      createdAt: existing?.createdAt ?? at,
    });
    if (existing === undefined) {
      tx.insert(tables.triggers)
        .values({ ...trigger, updatedAt: at })
        .run();
    } else {
      tx.update(tables.triggers).set(trigger).where(eq(tables.triggers.id, trigger.id)).run();
    }
    return { ok: true, value: trigger };
  }, IMMEDIATE);

// A removed trigger's fire log went with it, so its late fire is dropped, not refused: a
// foreign-key error would abort the rest of the tick.
const appendFireIn = (db: Db, fire: Fire): void =>
  db.transaction((tx) => {
    const held = tx
      .select({ id: tables.triggers.id })
      .from(tables.triggers)
      .where(eq(tables.triggers.id, fire.triggerId))
      .get();
    if (held !== undefined) tx.insert(tables.triggerFires).values(fire).run();
  }, IMMEDIATE);

export const triggerRepository = (db: Db): ITriggerRepository => ({
  list: async () => db.select().from(tables.triggers).all().map(toTrigger),
  find: async (project, name) => {
    const row = db
      .select()
      .from(tables.triggers)
      .where(and(eq(tables.triggers.project, project), eq(tables.triggers.name, name)))
      .get();
    return row === undefined ? undefined : toTrigger(row);
  },
  save: async (draft) => saveTriggerIn(db, draft, now()),
  remove: async (id) =>
    db
      .delete(tables.triggers)
      .where(eq(tables.triggers.id, id))
      .returning({ id: tables.triggers.id })
      .all().length > 0,
  // Matching the cron and timezone read leaves alone a trigger re-saved since (ADR 0023).
  setNextFireAt: async (trigger, nextFireAt) =>
    db
      .update(tables.triggers)
      .set({ nextFireAt })
      .where(
        and(
          eq(tables.triggers.id, trigger.id),
          eq(tables.triggers.cron, trigger.cron),
          eq(tables.triggers.timezone, trigger.timezone),
        ),
      )
      .returning({ id: tables.triggers.id })
      .all().length > 0,
  appendFire: async (fire) => appendFireIn(db, FireSchema.parse(fire)),
  // By rowid, not at: the tick writes a missed-slots fire and its firing with one at.
  readFires: async (triggerId, limit) =>
    db
      .select()
      .from(tables.triggerFires)
      .where(eq(tables.triggerFires.triggerId, triggerId))
      .orderBy(desc(sql`rowid`))
      .limit(limit)
      .all()
      .map(toFire)
      .toReversed(),
  importTrigger: async (trigger) =>
    db
      .insert(tables.triggers)
      .values({ ...trigger, updatedAt: now() })
      .onConflictDoNothing()
      .returning({ id: tables.triggers.id })
      .all().length > 0
      ? { ok: true, value: undefined }
      : { ok: false, error: `trigger ${trigger.id} is already stored` },
});
