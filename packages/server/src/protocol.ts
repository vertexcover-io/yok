import { isAbsolute, join } from "node:path";
import { WorkflowAgentSchema } from "@yok/core";
import {
  JsonObjectSchema,
  PermissionModeSchema,
  PolicyLayerSchema,
  SlugSchema,
  TiersConfigSchema,
  yokHome,
} from "@yok/sdk";
import * as z from "zod";

export const socketPath = (home: string = yokHome()): string => join(home, "yok.sock");
export const pidPath = (home: string = yokHome()): string => join(home, "server.pid");
export const logPath = (home: string = yokHome()): string => join(home, "server.log");

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), "must be an absolute path");

export const ErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(["bad-request", "not-found", "conflict", "agent-failed", "internal"]),
    message: z.string(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
export type ErrorCode = ErrorBody["error"]["code"];

export const StartRunBodySchema = z.strictObject({
  workflow: SlugSchema,
  workflowPath: AbsolutePathSchema,
  inputs: JsonObjectSchema,
  cwd: AbsolutePathSchema,
  name: SlugSchema.optional(),
  agent: WorkflowAgentSchema.default("claude"),
  // the workflow's tiers, merged over the built-in and the config's into the run's tier set
  tiers: TiersConfigSchema.default({}),
  // the top workflow's policies and the `yok run` flags' values; the server merges them over the
  // config's into the run's policies
  policies: z
    .strictObject({ workflow: PolicyLayerSchema.default({}), cli: PolicyLayerSchema.default({}) })
    .prefault({}),
  // the env the session starts with, which yok run builds from the project's .env, the config
  // and the workflow; required, so a caller that forgets it is refused rather than run without it
  env: z.record(z.string(), z.string()),
  // the config file yok run --config named; the run reads it instead of its checkout's
  config: AbsolutePathSchema.optional(),
  // a trigger's runs start in auto, so nobody is needed to answer a permission menu
  permissionMode: PermissionModeSchema.optional(),
});
export type StartRunBody = z.infer<typeof StartRunBodySchema>;
// What a caller sends: agent may be left out
export type StartRunRequest = z.input<typeof StartRunBodySchema>;

export const AddTriggerBodySchema = z.strictObject({
  workflowPath: AbsolutePathSchema,
  // the repo root the trigger's runs start in
  cwd: AbsolutePathSchema,
  config: AbsolutePathSchema.optional(),
});
export type AddTriggerBody = z.infer<typeof AddTriggerBodySchema>;

// A trigger's name is unique within its repo.
export const TriggerRefSchema = z.strictObject({ cwd: AbsolutePathSchema, name: SlugSchema });
export type TriggerRef = z.infer<typeof TriggerRefSchema>;

// The env the resumed session starts with, which yok resume builds the way yok run does
export const ResumeRunBodySchema = z.strictObject({ env: z.record(z.string(), z.string()) });
export type ResumeRunBody = z.infer<typeof ResumeRunBodySchema>;

export type ApiError = ErrorBody["error"];
