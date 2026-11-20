import * as z from "zod";
import { AbsolutePathSchema, NonEmptyStringSchema, SlugSchema } from "./contracts.ts";

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

// Saved in triggers.json before triggers named a project. yok import-files moves each one to
// the project at its cwd; the server neither reads nor fires it.
export const LegacyTriggerSchema = z.strictObject({
  ...scheduleFields,
  workflowPath: AbsolutePathSchema,
  cwd: AbsolutePathSchema,
});
export type LegacyTrigger = z.infer<typeof LegacyTriggerSchema>;

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
