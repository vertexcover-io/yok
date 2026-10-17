import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { DoctorReportSchema } from "@yok/core";
import {
  AbsolutePathSchema,
  JsonObjectSchema,
  NonEmptyStringSchema,
  PolicyLayerSchema,
  SlugSchema,
  SourceSchema,
  yokHome,
} from "@yok/sdk";
import * as z from "zod";

export const portPath = (home: string = yokHome()): string => join(home, "server.port");
export const homeEnvPath = (home: string = yokHome()): string => join(home, ".env");
export const pidPath = (home: string = yokHome()): string => join(home, "server.pid");
export const logPath = (home: string = yokHome()): string => join(home, "server.log");

const readHomeFile = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

export const readPort = (home: string): number | null => {
  const port = Number.parseInt(readHomeFile(portPath(home)), 10);
  return Number.isInteger(port) && port > 0 ? port : null;
};

export const readApiKey = (home: string): string | undefined =>
  parseEnv(readHomeFile(homeEnvPath(home))).YOK_API_KEY || undefined;

// Never put in process.env: the server hands its env to every run's agent session.
// base64url stays inside the bearer-token alphabet, so the key needs no quoting anywhere.
export const ensureApiKey = async (home: string): Promise<string> => {
  const existing = readApiKey(home);
  if (existing !== undefined) return existing;
  const key = randomBytes(32).toString("base64url");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await appendFile(homeEnvPath(home), `\nYOK_API_KEY=${key}\n`, { mode: 0o600 });
  // appendFile's mode applies only when it creates the file; a .env the person made keeps its own.
  await chmod(homeEnvPath(home), 0o600);
  return key;
};

export const ErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      "bad-request",
      "not-found",
      "conflict",
      "agent-failed",
      "git-failed",
      "internal",
      "unauthorized",
    ]),
    message: z.string(),
    // the doctor's report, when the doctor is why the request was refused
    findings: DoctorReportSchema.optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
export type ErrorCode = ErrorBody["error"]["code"];

// The agent, tiers and env come from the compiled workflow and the checkout, on the server.
export const StartRunBodySchema = z.strictObject({
  // a registered project's name; left out, the one registered project
  project: SlugSchema.optional(),
  // a shipped workflow's name, or a workflow file resolved against the project's checkout
  workflow: NonEmptyStringSchema,
  inputs: JsonObjectSchema,
  name: SlugSchema.optional(),
  // a config file read instead of the checkout's own, resolved against the checkout
  config: NonEmptyStringSchema.optional(),
  // the caller's own policy values; the server merges them over the workflow's and the config's
  policies: PolicyLayerSchema.optional(),
  // who asked for the run, recorded on it: metadata, never an authentication fact
  source: SourceSchema.optional(),
});
export type StartRunBody = z.infer<typeof StartRunBodySchema>;
export type StartRunRequest = StartRunBody;

export type ApiError = ErrorBody["error"];

export const ProjectSchema = z.strictObject({
  path: AbsolutePathSchema,
  git: z.string().optional(),
  addedBy: SourceSchema,
  addedAt: z.iso.datetime(),
  // the doctor's verdict at the last add or run start
  verdict: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

// Any other form, file:// or a transport helper such as ext::, would let a key holder read the
// server's own files through a clone. The URL is saved and listed to every caller, so it holds
// no password.
const GitUrlSchema = z
  .string()
  .regex(/^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)\S+$/, "must be an https, ssh or user@host: URL")
  .refine(
    (url) => !URL.canParse(url) || new URL(url).password === "",
    "must not hold a password; use a git credential helper or an ssh key",
  );

export const AddProjectBodySchema = z
  .strictObject({
    name: SlugSchema,
    git: GitUrlSchema.optional(),
    // with git: where to clone to, default <home>/projects/NAME
    path: AbsolutePathSchema.optional(),
    addedBy: SourceSchema.default({ channel: "api" }),
  })
  .refine((body) => body.git !== undefined || body.path !== undefined, "give git, path, or both");
export type AddProjectBody = z.infer<typeof AddProjectBodySchema>;
export type AddProjectRequest = z.input<typeof AddProjectBodySchema>;

export type ProjectView = Project &
  Readonly<{ name: string; status: "ready" | "blocked" | "missing" }>;
